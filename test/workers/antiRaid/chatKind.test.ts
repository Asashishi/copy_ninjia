import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";

let resolveChat!: (chat: { type: "group" | "supergroup" }) => void;
const getChat = mock((): Promise<{ type: "group" | "supergroup" }> =>
  new Promise((resolve: (chat: { type: "group" | "supergroup" }) => void): void => {
    resolveChat = resolve;
  })
);

mock.module("../../../packages/infra/telegram", () => ({
  telegramApi: { getChat },
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error: mock((..._args: unknown[]): void => {}) }),
}));

const chatKind = await import("../../../packages/workers/antiRaid/chatKind");
const {
  workerChatIsSupergroup,
  workerChatKindFetches,
} = await import("../../../packages/cache/workers/antiRaid/chatKind");

beforeEach((): void => {
  chatKind.resetWorkerChatKind();
  getChat.mockClear();
});

describe("Anti-Raid Worker 群类型反查", () => {
  test("同群并发复用一次 getChat，并缓存确证结果", async () => {
    const first: Promise<boolean | undefined> =
      chatKind.resolveChatIsSupergroup(-1001);
    const second: Promise<boolean | undefined> =
      chatKind.resolveChatIsSupergroup(-1001);

    expect(first).toBe(second);
    expect(getChat).toHaveBeenCalledTimes(1);
    resolveChat({ type: "group" });
    await expect(first).resolves.toBeFalse();
    expect(workerChatKindFetches.size).toBe(0);
    expect(workerChatIsSupergroup.get(-1001)).toBeFalse();
  });

  test("主线程镜像到达后，迟到的 getChat 结果不得覆盖更新值", async () => {
    const lookup: Promise<boolean | undefined> =
      chatKind.resolveChatIsSupergroup(-1002);
    chatKind.applyChatKindChange(-1002, false);
    resolveChat({ type: "supergroup" });

    await expect(lookup).resolves.toBeFalse();
    expect(workerChatIsSupergroup.get(-1002)).toBeFalse();
    expect(workerChatKindFetches.size).toBe(0);
  });
});
