import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

class FakeGrammyError extends Error {
  constructor(
    readonly error_code: number,
    readonly parameters: { retry_after?: number } = {}
  ) {
    super(`Telegram ${error_code}`);
  }
}

const setMessageReaction = mock(async (..._args: unknown[]): Promise<boolean> => true);
const logApiError = mock((..._args: unknown[]): void => {});
const sleep = mock(async (..._args: unknown[]): Promise<void> => {});
const loggerLog = mock((..._args: unknown[]): void => {});
const loggerWarn = mock((..._args: unknown[]): void => {});
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("grammy", () => ({ GrammyError: FakeGrammyError }));
mock.module("../../src/infra/telegram", () => ({
  bot: { api: { setMessageReaction } },
  logApiError,
}));
mock.module("../../src/libs/sleep", () => ({ sleep }));
mock.module("../../src/infra/logger", () => ({
  logger: { log: loggerLog, info: mock(() => {}), warn: loggerWarn, error: loggerError },
}));

const { enqueueReaction } = await import("../../src/copy/reactionQueue");
const { chatQueues, consumingChats, pendingTasks } = await import("../../src/cache/reactionQueue");

async function waitForIdle(): Promise<void> {
  for (let attempt: number = 0; attempt < 30; attempt++) {
    if (consumingChats.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for reaction queue");
}

beforeEach(() => {
  pendingTasks.clear();
  chatQueues.clear();
  consumingChats.clear();
  for (const mocked of [setMessageReaction, logApiError, sleep, loggerLog, loggerWarn, loggerError]) mocked.mockClear();
  setMessageReaction.mockImplementation(async (): Promise<boolean> => true);
  sleep.mockImplementation(async (): Promise<void> => {});
});

afterEach(() => {
  pendingTasks.clear();
  chatQueues.clear();
  consumingChats.clear();
});

describe("Telegram reaction 同步队列", () => {
  test("成功调用后清理本群队列并记录分段延迟", async () => {
    enqueueReaction(-1001, 10, [{ type: "emoji", emoji: "👍" }], 1, Math.floor(Date.now() / 1000));
    await waitForIdle();

    expect(setMessageReaction).toHaveBeenCalledWith(-1001, 10, [{ type: "emoji", emoji: "👍" }]);
    expect(pendingTasks.size).toBe(0);
    expect(chatQueues.size).toBe(0);
    expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining("Reaction synced"));
  });

  test("API 在途时同消息的新 update 覆盖旧状态，并在旧调用落定后补发最新状态", async () => {
    let resolveFirst!: (value: boolean) => void;
    setMessageReaction.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));

    enqueueReaction(-1001, 10, [{ type: "emoji", emoji: "👍" }], 10, 1);
    enqueueReaction(-1001, 10, [{ type: "emoji", emoji: "🔥" }], 11, 2);
    enqueueReaction(-1001, 10, [{ type: "emoji", emoji: "😁" }], 9, 3);
    expect(setMessageReaction).toHaveBeenCalledTimes(1);

    resolveFirst(true);
    await waitForIdle();
    expect(setMessageReaction).toHaveBeenCalledTimes(2);
    expect(setMessageReaction).toHaveBeenNthCalledWith(2, -1001, 10, [{ type: "emoji", emoji: "🔥" }]);
  });

  test("429 按 retry_after 等待后重试，其它错误记录后放弃", async () => {
    setMessageReaction
      .mockRejectedValueOnce(new FakeGrammyError(429, { retry_after: 2 }))
      .mockResolvedValueOnce(true);
    enqueueReaction(-1001, 10, [], 1, 1);
    await waitForIdle();
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining("retry 2/3"));
    expect(setMessageReaction).toHaveBeenCalledTimes(2);

    setMessageReaction.mockRejectedValueOnce(new Error("bad reaction"));
    enqueueReaction(-1002, 20, [], 2, 2);
    await waitForIdle();
    expect(logApiError).toHaveBeenCalledWith("set message reaction", expect.any(Error));
    expect(pendingTasks.size).toBe(0);
  });
});
