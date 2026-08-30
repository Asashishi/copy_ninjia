/**
 * Anti-Raid 主线程控制器（packages/antiRaid/workerBridge/controller.ts）的
 * 四个公开控制命令与双工能力分派。
 *
 * 与 workerBridgeObservers.test.ts 分工：那一条驱动的是「注册一次、由上游回调」
 * 的四个观察者；本文件驱动的是命令侧——`/antiraid disable`、`/ad_detect disable`、
 * `/flood_control disable` 与统一 teardown 各自投什么、以及 Worker 不可用时它们
 * 必须上抛而不是静默吞掉。命令静默失败最难在群里发现：管理员看到一句成功回执，
 * 而 Worker 里那个群的验证窗口、待检队列或发言窗口原封不动。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid/protocol";

const workerPosts: AntiRaidWorkerMessage[] = [];
/** post 的返回值；false 模拟「Worker 正在重建或已放弃」。 */
const delivery: { accepts: boolean } = { accepts: true };
const deletedDeferralChats: number[] = [];
const grantedPermits: unknown[] = [];
const telegramRequests: unknown[] = [];
const telegramTransfers: unknown[] = [];
const adBypassIds: Set<number> = new Set<number>();
const permanentWhitelistIds: Set<number> = new Set<number>();
let identityPrefetchSucceeds: boolean = true;
const prefetchIdentityPolicies = mock(async (): Promise<boolean> =>
  identityPrefetchSucceeds
);

/** superviseDuplexWorker 收到的 options；用来直接驱动 handleRequest 等回调。 */
const captured: { options?: Record<string, any> } = {};

mock.module("../../packages/infra/supervisedDuplexWorker", () => ({
  superviseDuplexWorker: (options: Record<string, any>) => {
    captured.options = options;
    return {
      init: (): void => {},
      post: (message: AntiRaidWorkerMessage): boolean => {
        if (!delivery.accepts) return false;
        workerPosts.push(message);
        return true;
      },
      terminate: async (): Promise<void> => {},
    };
  },
}));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub() }));
mock.module("../../packages/antiRaid/verificationAttempts", () => ({
  advanceDeferredVerificationGeneration: (): void => {},
  deleteDeferredVerificationsForChat: (chatId: number): void => {
    deletedDeferralChats.push(chatId);
  },
  grantVerificationAttempt: (request: unknown): { granted: true } => {
    grantedPermits.push(request);
    return { granted: true };
  },
  // 整份模块被替换掉时缺一个导出就会在 import 阶段报 Export not found；
  // 这两个本文件不驱动，只为让模块形状完整。
  acceptVerificationDeferred: (): boolean => false,
  settlePersistedVerificationDeferral: (): boolean => false,
  resetVerificationAttemptRuntime: (): void => {},
}));
mock.module("../../packages/infra/telegram/workerRequests", () => ({
  handleAntiRaidWorkerTelegramRequest: async (
    request: unknown,
    _signal: AbortSignal
  ): Promise<string> => {
    telegramRequests.push(request);
    return "telegram-result";
  },
  telegramWorkerResponseTransfer: (
    request: unknown,
    _value: unknown
  ): undefined => {
    telegramTransfers.push(request);
    return undefined;
  },
}));
const identityStorage = await import("../../packages/infra/identityStorage");
mock.module("../../packages/infra/identityStorage", () => ({
  ...identityStorage,
  prefetchIdentityPolicies,
}));
const whitelistPolicy = await import("../../packages/infra/identityPolicy/whitelist");
mock.module("../../packages/infra/identityPolicy/whitelist", () => ({
  ...whitelistPolicy,
  hasWhitelistPermission: (id: number, key: string): boolean =>
    key === "isCanBypassAdDetection" && adBypassIds.has(id),
  isWhitelisted: (id: number): boolean => permanentWhitelistIds.has(id),
}));
const temporaryWhitelistPolicy = await import(
  "../../packages/infra/identityPolicy/temporaryWhitelist"
);
mock.module("../../packages/infra/identityPolicy/temporaryWhitelist", () => ({
  ...temporaryWhitelistPolicy,
  hasActiveTemporaryWhitelist: (id: number): boolean => adBypassIds.has(id),
}));
mock.module("../../packages/antiRaid/workerBridge/observers", () => ({
  registerAntiRaidBridgeObservers: (): void => {},
}));

const {
  clearAdDetection,
  clearFloodControl,
  deactivateAntiRaidChat,
  deactivateJoinGuardChat,
  postAntiRaid,
} = await import("../../packages/antiRaid/workerBridge/controller");

const CHAT_ID: number = -1001;

function typesOf(): string[] {
  return workerPosts.map((message: AntiRaidWorkerMessage): string => message.type);
}

beforeEach(() => {
  workerPosts.length = 0;
  deletedDeferralChats.length = 0;
  grantedPermits.length = 0;
  telegramRequests.length = 0;
  telegramTransfers.length = 0;
  adBypassIds.clear();
  permanentWhitelistIds.clear();
  identityPrefetchSucceeds = true;
  prefetchIdentityPolicies.mockClear();
  delivery.accepts = true;
});

describe("Anti-Raid 控制命令", () => {
  test("统一 teardown 先丢本进程延后闩锁，再投 deactivateChat 并带上清理标记", () => {
    deactivateAntiRaidChat(CHAT_ID, true);

    expect(deletedDeferralChats).toEqual([CHAT_ID]);
    expect(workerPosts).toEqual([{
      type: "deactivateChat",
      chatId: CHAT_ID,
      cleanupVerificationMessages: true,
    }]);
  });

  test("teardown 的清理标记原样传下去，不在主线程改写", () => {
    deactivateAntiRaidChat(CHAT_ID, false);

    expect(workerPosts).toEqual([{
      type: "deactivateChat",
      chatId: CHAT_ID,
      cleanupVerificationMessages: false,
    }]);
  });

  test("/antiraid disable 只收验证与 lockdown，同样先丢延后闩锁", () => {
    deactivateJoinGuardChat(CHAT_ID);

    expect(deletedDeferralChats).toEqual([CHAT_ID]);
    expect(workerPosts).toEqual([{ type: "deactivateJoinGuard", chatId: CHAT_ID }]);
  });

  test("/ad_detect disable 与 /flood_control disable 各自只投自己那条", () => {
    clearAdDetection(CHAT_ID);
    clearFloodControl(CHAT_ID);

    // 两条互不牵连：把待检队列和发言窗口一起清掉是这一带最容易犯的错。
    expect(typesOf()).toEqual(["clearAdDetect", "clearFloodControl"]);
    expect(deletedDeferralChats).toEqual([]);
  });

  test("Worker 不可用时四条控制命令一律上抛，不静默吞掉", () => {
    delivery.accepts = false;

    expect(() => deactivateAntiRaidChat(CHAT_ID, true))
      .toThrow("Anti-Raid Worker is unavailable.");
    expect(() => deactivateJoinGuardChat(CHAT_ID))
      .toThrow("Anti-Raid Worker is unavailable.");
    expect(() => clearAdDetection(CHAT_ID))
      .toThrow("Anti-Raid Worker is unavailable.");
    expect(() => clearFloodControl(CHAT_ID))
      .toThrow("Anti-Raid Worker is unavailable.");
    expect(workerPosts).toEqual([]);
  });

  test("尽力投递的 postAntiRaid 只报结果，不上抛", () => {
    delivery.accepts = false;
    expect(postAntiRaid({ type: "clearAdDetect", chatId: CHAT_ID })).toBeFalse();

    delivery.accepts = true;
    expect(postAntiRaid({ type: "clearAdDetect", chatId: CHAT_ID })).toBeTrue();
    expect(typesOf()).toEqual(["clearAdDetect"]);
  });
});

describe("Anti-Raid 双工能力分派", () => {
  test("验证名额许可在主线程就地结算，不进 Telegram 边界", async () => {
    const request = { operation: "verificationAttemptPermit", chatId: CHAT_ID } as never;

    const value: unknown = await captured.options!.handleRequest(
      request,
      new AbortController().signal
    );

    expect(value).toEqual({ granted: true });
    expect(grantedPermits).toEqual([request]);
    expect(telegramRequests).toEqual([]);
  });

  test("其余能力请求交给 Telegram 边界", async () => {
    const request = { operation: "sendMessage", chatId: CHAT_ID } as never;

    const value: unknown = await captured.options!.handleRequest(
      request,
      new AbortController().signal
    );

    expect(value).toBe("telegram-result");
    expect(telegramRequests).toEqual([request]);
    expect(grantedPermits).toEqual([]);
  });

  test("引用广告警告发送前复查当前豁免，冷读失败同样不误警告", async () => {
    const request = {
      operation: "sendTemporaryMessage",
      category: "message",
      chatId: CHAT_ID,
      identityId: 7,
      text: "warning",
      deleteAfterMs: 30_000,
    } as never;

    adBypassIds.add(7);
    await expect(captured.options!.handleRequest(
      request,
      new AbortController().signal
    )).resolves.toEqual({ suppressed: true });
    expect(telegramRequests).toEqual([]);

    adBypassIds.clear();
    permanentWhitelistIds.add(7);
    await expect(captured.options!.handleRequest(
      request,
      new AbortController().signal
    )).resolves.toEqual({ suppressed: true });
    expect(telegramRequests).toEqual([]);

    permanentWhitelistIds.clear();
    identityPrefetchSucceeds = false;
    await expect(captured.options!.handleRequest(
      request,
      new AbortController().signal
    )).resolves.toEqual({ suppressed: true });
    expect(telegramRequests).toEqual([]);

    identityPrefetchSucceeds = true;
    await expect(captured.options!.handleRequest(
      request,
      new AbortController().signal
    )).resolves.toBe("telegram-result");
    expect(telegramRequests).toEqual([request]);
  });

  test("许可回执没有可转移缓冲；只有 Telegram 回执才问 transfer 清单", () => {
    // 许可的返回值是一个小对象，问一次 transfer 只会白走一遍 Telegram 那侧的
    // 判定；而真把它当成可转移缓冲交出去，主线程就再也读不到它了。
    expect(captured.options!.responseTransfer(
      { operation: "verificationAttemptPermit" } as never,
      { granted: true }
    )).toBeUndefined();
    expect(telegramTransfers).toEqual([]);

    const download = { operation: "downloadFile" } as never;
    captured.options!.responseTransfer(download, new ArrayBuffer(8));
    expect(telegramTransfers).toEqual([download]);
  });

  test("Worker 监督句柄按既定标签与放弃后果注册", () => {
    expect(captured.options!.label).toBe("Anti-raid guard Worker");
    expect(captured.options!.giveUpConsequence).toContain("join verification");
  });
});
