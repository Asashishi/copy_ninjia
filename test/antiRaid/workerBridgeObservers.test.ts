import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type {
  DiskBusinessMessage,
  DiskIORecoveryTransport,
  VerificationPersistedReply,
} from "../../packages/types";
import type { AntiRaidWorkerMessage } from "../../packages/types/antiRaid/protocol";
import type { BotChatPermissions } from "../../packages/types/telegram";
import type { ChatTeardownReason } from "../../packages/types/chatTeardown";

/**
 * Anti-Raid 主线程侧的四个观察者（权限镜像、群 teardown、Disk I/O 重生重放、
 * 验证落盘回执）。
 *
 * 它们都是**注册一次、由上游在别的时刻回调**的闭包，因此整条 workerBridge 的
 * 集成测试只覆盖到「注册发生了」，四个回调体本身此前一行没跑过。而它们承担的
 * 恰恰是重建与落盘边界上最不容易复现的几件事：Worker 重生后把镜像整份重放回去
 * （中途投递失败必须立刻停手并报失败，不能只重放一半就宣称成功），以及落盘回执
 * 的代际/修订号核对（对不上就必须整条丢弃，否则会拿一份陈旧回执去解开新一代的
 * 等待）。这里把四个回调抓出来直接驱动。
 */

const post = mock((_message: AntiRaidWorkerMessage): boolean => true);
const deactivateChat = mock((_chatId: number, _cleanup: boolean): void => {});
const settleDeferral = mock((..._args: unknown[]): boolean => false);
const loggerError = mock((..._args: unknown[]): void => {});

/** 上游注册时交出的回调；每个用例从这里直接驱动。 */
const captured: {
  permissions?: (chatId: number, permissions: BotChatPermissions | undefined) => void;
  teardown?: (chatId: number, reason: ChatTeardownReason) => void;
  respawn?: (transport: DiskIORecoveryTransport) => boolean;
  persisted?: (reply: VerificationPersistedReply) => void;
} = {};

mock.module("../../packages/infra/botAdmin", () => ({
  registerBotPermissionObserver: (
    observer: (chatId: number, permissions: BotChatPermissions | undefined) => void
  ): void => { captured.permissions = observer; },
}));
mock.module("../../packages/infra/chatTeardown", () => ({
  registerChatTeardown: (
    _owner: string,
    observer: (chatId: number, reason: ChatTeardownReason) => void
  ): void => { captured.teardown = observer; },
}));
mock.module("../../packages/infra/diskIO", () => ({
  onDiskIORespawn: (
    _label: string,
    _priority: number,
    replay: (transport: DiskIORecoveryTransport) => boolean
  ): void => { captured.respawn = replay; },
  onVerificationPersisted: (
    observer: (reply: VerificationPersistedReply) => void
  ): void => { captured.persisted = observer; },
}));
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));
mock.module("../../packages/antiRaid/verificationAttempts", () => ({
  settlePersistedVerificationDeferral: settleDeferral,
}));

const { registerAntiRaidBridgeObservers } = await import(
  "../../packages/antiRaid/workerBridge/observers"
);
const {
  activeVerificationSnapshots,
  pendingVerificationDeletes,
  persistedVerificationRevisions,
} = await import("../../packages/cache/main/antiRaid/verificationMirror");
const { chatIsSupergroupById } = await import("../../packages/cache/main/antiRaid/chatKind");

registerAntiRaidBridgeObservers({ post, deactivateChat });

/** 一份最小但字段齐全的待验证快照。 */
function snapshot(userId: number, revision: number): Record<string, unknown> {
  return {
    chatId: -1001,
    userId,
    generation: 1,
    revision,
    label: `@u${userId}`,
    isBot: false,
    trackedMessageTimes: [],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 2_000,
    phase: "pending",
  };
}

beforeEach(() => {
  post.mockClear();
  post.mockImplementation((): boolean => true);
  deactivateChat.mockClear();
  settleDeferral.mockClear();
  settleDeferral.mockImplementation((): boolean => false);
  loggerError.mockClear();
  activeVerificationSnapshots.clear();
  pendingVerificationDeletes.clear();
  persistedVerificationRevisions.clear();
  chatIsSupergroupById.clear();
});

describe("Anti-Raid 主线程观察者", () => {
  test("权限镜像有值时带 permissions 推送，观测不到时只推 chatId", () => {
    captured.permissions?.(-1001, {
      canDeleteMessages: true,
      canRestrictMembers: true,
      canInviteUsers: true,
      canPromoteMembers: false,
      canChangeInfo: false,
      canPinMessages: false,
    } as unknown as BotChatPermissions);
    const withPermissions = post.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(withPermissions.type).toBe("botPermissionsChanged");
    expect(withPermissions.chatId).toBe(-1001);
    expect(withPermissions.permissions).toBeDefined();

    // 三态：undefined 表示「没观测到」，绝不能被投影成一份「什么都不能做」的权限，
    // 那会让 Worker 把尚未查明的群当成确证无权限而放弃处置。
    post.mockClear();
    captured.permissions?.(-1002, undefined);
    const unknownPermissions = post.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(unknownPermissions.chatId).toBe(-1002);
    expect("permissions" in unknownPermissions).toBeFalse();
  });

  test("群 teardown 只有显式关闭才连带清理验证痕迹，失去权限时不清，且一律摘掉群类型镜像", () => {
    chatIsSupergroupById.set(-1001, true);
    captured.teardown?.(-1001, "explicitDisable");
    expect(deactivateChat).toHaveBeenCalledWith(-1001, true);
    expect(chatIsSupergroupById.has(-1001)).toBeFalse();

    chatIsSupergroupById.set(-1002, true);
    captured.teardown?.(-1002, "lostAuthority");
    expect(deactivateChat).toHaveBeenLastCalledWith(-1002, false);
    expect(chatIsSupergroupById.has(-1002)).toBeFalse();
  });

  test("Worker 重生重放把镜像与在途删除整份交出去", () => {
    activeVerificationSnapshots.set("-1001:7", snapshot(7, 1) as never);
    activeVerificationSnapshots.set("-1001:8", snapshot(8, 1) as never);
    pendingVerificationDeletes.set("-1001:9", {
      chatId: -1001, userId: 9, generation: 1, revision: 3,
    });
    const posted: DiskBusinessMessage[] = [];
    const transport: DiskIORecoveryTransport = {
      post: (message: DiskBusinessMessage): boolean => { posted.push(message); return true; },
      ensureLuckReceiptSecret: async (): Promise<never> => { throw new Error("unused"); },
    } as unknown as DiskIORecoveryTransport;

    expect(captured.respawn?.(transport)).toBeTrue();
    expect(posted).toHaveLength(3);
    expect(posted.filter((m) => m.type === "verificationUpsert")).toHaveLength(2);
    // 重放的 upsert 必须标 critical：这一批是「重建后重新证明这些事实还在」，
    // 被当成可丢的普通写就等于重放了个寂寞。
    expect(posted.every((m) => m.type !== "verificationUpsert" || (m as { critical: boolean }).critical)).toBeTrue();
    expect(posted.at(-1)?.type).toBe("verificationDelete");
  });

  test("重放中途投递失败立即停手并报失败，不谎称整份都放完了", () => {
    activeVerificationSnapshots.set("-1001:7", snapshot(7, 1) as never);
    activeVerificationSnapshots.set("-1001:8", snapshot(8, 1) as never);
    pendingVerificationDeletes.set("-1001:9", {
      chatId: -1001, userId: 9, generation: 1, revision: 3,
    });
    let accepted: number = 0;
    const transport: DiskIORecoveryTransport = {
      post: (): boolean => { accepted++; return accepted < 2; },
      ensureLuckReceiptSecret: async (): Promise<never> => { throw new Error("unused"); },
    } as unknown as DiskIORecoveryTransport;

    expect(captured.respawn?.(transport)).toBeFalse();
    // 第二条被拒即返回：不得继续尝试后面的删除。
    expect(accepted).toBe(2);
  });

  test("落盘回执按代际与修订号核对，对不上的整条丢弃", () => {
    activeVerificationSnapshots.set("-1001:7", snapshot(7, 5) as never);

    // 代际对不上：既不记修订号，也不回投 Worker。
    captured.persisted?.({ type: "verificationPersisted", key: "-1001:7", generation: 2, revision: 5, deleted: false });
    expect(persistedVerificationRevisions.has("-1001:7")).toBeFalse();
    expect(post).not.toHaveBeenCalled();

    // 修订号对不上：同上。
    captured.persisted?.({ type: "verificationPersisted", key: "-1001:7", generation: 1, revision: 4, deleted: false });
    expect(persistedVerificationRevisions.has("-1001:7")).toBeFalse();
    expect(post).not.toHaveBeenCalled();

    // 完全对上：记修订号并把回执转给 Worker。
    captured.persisted?.({ type: "verificationPersisted", key: "-1001:7", generation: 1, revision: 5, deleted: false });
    expect(persistedVerificationRevisions.get("-1001:7")).toEqual({ generation: 1, revision: 5 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toEqual({
      type: "verificationPersisted", key: "-1001:7", generation: 1, revision: 5,
    });
  });

  test("回执已被本地延迟结算认领时不再回投 Worker", () => {
    activeVerificationSnapshots.set("-1001:7", snapshot(7, 5) as never);
    settleDeferral.mockImplementation((): boolean => true);

    captured.persisted?.({ type: "verificationPersisted", key: "-1001:7", generation: 1, revision: 5, deleted: false });
    expect(persistedVerificationRevisions.get("-1001:7")).toEqual({ generation: 1, revision: 5 });
    expect(post).not.toHaveBeenCalled();
  });

  test("Worker 拒收回执时留一行日志，交给重生重放补投", () => {
    activeVerificationSnapshots.set("-1001:7", snapshot(7, 5) as never);
    post.mockImplementation((): boolean => false);

    captured.persisted?.({ type: "verificationPersisted", key: "-1001:7", generation: 1, revision: 5, deleted: false });
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(String(loggerError.mock.calls[0]![0])).toContain("-1001:7");
  });

  test("删除回执只在代际与修订号都对上时才销掉在途删除", () => {
    pendingVerificationDeletes.set("-1001:9", {
      chatId: -1001, userId: 9, generation: 1, revision: 3,
    });

    captured.persisted?.({ type: "verificationPersisted", key: "-1001:9", generation: 1, revision: 2, deleted: true });
    expect(pendingVerificationDeletes.has("-1001:9")).toBeTrue();

    captured.persisted?.({ type: "verificationPersisted", key: "-1001:9", generation: 1, revision: 3, deleted: true });
    expect(pendingVerificationDeletes.has("-1001:9")).toBeFalse();
  });
});
