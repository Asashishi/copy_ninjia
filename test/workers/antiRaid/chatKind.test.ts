import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { VERIFICATION_CHAT_KIND_FETCH_MAX } from "../../../packages/consts/antiRaid/verification";

interface PendingChatRequest {
  readonly chatId: number;
  readonly resolve: (chat: { type: "group" | "supergroup" | "private" }) => void;
  readonly reject: (error: Error) => void;
}

const pendingChatRequests: PendingChatRequest[] = [];
const getChat = mock((chatId: number): Promise<{ type: "group" | "supergroup" | "private" }> =>
  new Promise((
    resolve: (chat: { type: "group" | "supergroup" | "private" }) => void,
    reject: (error: Error) => void
  ): void => {
    pendingChatRequests.push({ chatId, resolve, reject });
  })
);
const logError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/infra/telegram", () => ({
  telegramApi: { getChat },
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error: logError }),
}));

const chatKind = await import("../../../packages/workers/antiRaid/chatKind");
const {
  workerChatIsSupergroup,
  workerChatKindFetches,
  workerChatKindActiveFetches,
} = await import("../../../packages/cache/workers/antiRaid/chatKind");

beforeEach((): void => {
  chatKind.resetWorkerChatKind();
  getChat.mockClear();
  logError.mockClear();
  pendingChatRequests.length = 0;
});

describe("Anti-Raid Worker 群类型反查", () => {
  test("同群并发复用一次 getChat，并缓存确证结果", async () => {
    const first: Promise<boolean | undefined> = chatKind.resolveChatIsSupergroup(-1001);
    const second: Promise<boolean | undefined> = chatKind.resolveChatIsSupergroup(-1001);

    expect(first).toBe(second);
    expect(getChat).toHaveBeenCalledTimes(1);
    pendingChatRequests[0]!.resolve({ type: "group" });
    await expect(first).resolves.toBeFalse();
    expect(workerChatKindFetches.size).toBe(0);
    expect(workerChatKindActiveFetches.size).toBe(0);
    expect(workerChatIsSupergroup.get(-1001)).toBeFalse();
  });

  test("主线程镜像到达后，迟到的 getChat 结果不得覆盖更新值", async () => {
    const lookup: Promise<boolean | undefined> = chatKind.resolveChatIsSupergroup(-1002);
    chatKind.applyChatKindChange(-1002, false);
    pendingChatRequests[0]!.resolve({ type: "supergroup" });

    await expect(lookup).resolves.toBeFalse();
    expect(workerChatIsSupergroup.get(-1002)).toBeFalse();
    expect(workerChatKindFetches.size).toBe(0);
    expect(workerChatKindActiveFetches.size).toBe(0);
  });

  test("非群结果与查询失败保持未知且不缓存", async () => {
    const nonGroup: Promise<boolean | undefined> = chatKind.resolveChatIsSupergroup(-1003);
    pendingChatRequests[0]!.resolve({ type: "private" });
    await expect(nonGroup).resolves.toBeUndefined();

    const failed: Promise<boolean | undefined> = chatKind.resolveChatIsSupergroup(-1004);
    pendingChatRequests[1]!.reject(new Error("getChat unavailable"));
    await expect(failed).resolves.toBeUndefined();

    expect(workerChatIsSupergroup.size).toBe(0);
    expect(workerChatKindActiveFetches.size).toBe(0);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  test("镜像和停管作废旧槽位后，真实在途 getChat 仍占并发名额", async () => {
    const old: Promise<boolean | undefined> = chatKind.resolveChatIsSupergroup(-1005);
    chatKind.applyChatKindChange(-1005, true);
    chatKind.forgetWorkerChatKind(-1005);

    const others: Promise<boolean | undefined>[] = [];
    for (let index: number = 1; index < VERIFICATION_CHAT_KIND_FETCH_MAX; index += 1) {
      others.push(chatKind.resolveChatIsSupergroup(-1005 - index));
    }
    expect(workerChatKindFetches.size).toBe(VERIFICATION_CHAT_KIND_FETCH_MAX - 1);
    expect(workerChatKindActiveFetches.size).toBe(VERIFICATION_CHAT_KIND_FETCH_MAX);
    await expect(chatKind.resolveChatIsSupergroup(-1005)).resolves.toBeUndefined();
    expect(getChat).toHaveBeenCalledTimes(VERIFICATION_CHAT_KIND_FETCH_MAX);

    pendingChatRequests[0]!.resolve({ type: "supergroup" });
    await expect(old).resolves.toBeUndefined();
    expect(workerChatKindActiveFetches.size).toBe(VERIFICATION_CHAT_KIND_FETCH_MAX - 1);

    const replacement: Promise<boolean | undefined> = chatKind.resolveChatIsSupergroup(-1005);
    expect(getChat).toHaveBeenCalledTimes(VERIFICATION_CHAT_KIND_FETCH_MAX + 1);
    pendingChatRequests[VERIFICATION_CHAT_KIND_FETCH_MAX]!.resolve({ type: "group" });
    await expect(replacement).resolves.toBeFalse();
    for (let index: number = 1; index < VERIFICATION_CHAT_KIND_FETCH_MAX; index += 1) {
      pendingChatRequests[index]!.resolve({ type: "supergroup" });
    }
    await Promise.allSettled(others);
    expect(workerChatKindActiveFetches.size).toBe(0);
  });

  test("Worker 停止后迟到的查询不能恢复旧镜像", async () => {
    const old: Promise<boolean | undefined> = chatKind.resolveChatIsSupergroup(-1006);
    chatKind.resetWorkerChatKind();
    pendingChatRequests[0]!.resolve({ type: "group" });

    await expect(old).resolves.toBeUndefined();
    expect(workerChatIsSupergroup.size).toBe(0);
    expect(workerChatKindActiveFetches.size).toBe(0);
  });
});
