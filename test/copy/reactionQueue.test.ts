import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MAX_PENDING_TASKS_PER_CHAT } from "../../packages/consts/reactionQueue";

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
mock.module("../../packages/infra/telegram", () => ({
  bot: { api: { setMessageReaction } },
  logApiError,
}));
mock.module("../../packages/libs/sleep", () => ({ sleep }));
mock.module("../../packages/infra/logger", () => ({
  logger: { log: loggerLog, info: mock(() => {}), warn: loggerWarn, error: loggerError },
}));

const {
  drainReactionQueue,
  enqueueReaction,
  initReactionQueue,
  quiesceReactionQueue,
} = await import("../../packages/copy/reactionQueue");
const {
  chatQueues,
  consumingChats,
  pendingReactionWaiters,
  pendingTasks,
  reactionDrainWaiters,
} = await import("../../packages/cache/reactionQueue");

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
  pendingReactionWaiters.clear();
  reactionDrainWaiters.clear();
  initReactionQueue();
  for (const mocked of [setMessageReaction, logApiError, sleep, loggerLog, loggerWarn, loggerError]) mocked.mockClear();
  setMessageReaction.mockImplementation(async (): Promise<boolean> => true);
  sleep.mockImplementation(async (): Promise<void> => {});
});

afterEach(() => {
  pendingTasks.clear();
  chatQueues.clear();
  consumingChats.clear();
  pendingReactionWaiters.clear();
  reactionDrainWaiters.clear();
});

describe("Telegram reaction 同步队列", () => {
  test("drain 拒绝非有限与负预算", () => {
    expect(() => drainReactionQueue(-1)).toThrow("non-negative finite");
    expect(() => drainReactionQueue(Number.NaN)).toThrow("non-negative finite");
    expect(() => drainReactionQueue(Number.POSITIVE_INFINITY)).toThrow("non-negative finite");
  });

  test("零预算在空闲时直接结算为 flushed", async () => {
    await expect(drainReactionQueue(0)).resolves.toBe("flushed");
  });

  test("零预算在有任务在途时立即 abort 并结算为 timedOut", async () => {
    setMessageReaction.mockImplementationOnce(async (...args: unknown[]): Promise<boolean> => await new Promise<boolean>((_resolve, reject) => {
      const signal = args[4] as AbortSignal | undefined;
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    enqueueReaction({ chatId: -1001, messageId: 10, reactions: [], updateId: 1, reactedAtUnix: 1 });
    await Bun.sleep(0);
    expect(setMessageReaction).toHaveBeenCalledTimes(1);

    quiesceReactionQueue();
    await expect(drainReactionQueue(0)).resolves.toBe("timedOut");
    await waitForIdle();

    // abort 后不再重试，未开始的任务全部结算，见 docs/04-invariants.md 停机不变量。
    expect(setMessageReaction).toHaveBeenCalledTimes(1);
    expect(pendingTasks.size).toBe(0);
    expect(pendingReactionWaiters.size).toBe(0);
    expect(reactionDrainWaiters.size).toBe(0);
  });

  test("成功调用后清理本群队列并记录分段延迟", async () => {
    enqueueReaction({
      chatId: -1001,
      messageId: 10,
      reactions: [{ type: "emoji", emoji: "👍" }],
      updateId: 1,
      reactedAtUnix: Math.floor(Date.now() / 1000),
    });
    await waitForIdle();

    expect(setMessageReaction).toHaveBeenCalledWith(
      -1001,
      10,
      [{ type: "emoji", emoji: "👍" }],
      {},
      expect.any(AbortSignal)
    );
    expect(pendingTasks.size).toBe(0);
    expect(chatQueues.size).toBe(0);
    expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining("Reaction synced"));
  });

  test("API 在途时同消息的新 update 覆盖旧状态，并在旧调用落定后补发最新状态", async () => {
    let resolveFirst!: (value: boolean) => void;
    setMessageReaction.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));

    const first = enqueueReaction({ chatId: -1001, messageId: 10, reactions: [{ type: "emoji", emoji: "👍" }], updateId: 10, reactedAtUnix: 1 });
    const latest = enqueueReaction({ chatId: -1001, messageId: 10, reactions: [{ type: "emoji", emoji: "🔥" }], updateId: 11, reactedAtUnix: 2 });
    const stale = enqueueReaction({ chatId: -1001, messageId: 10, reactions: [{ type: "emoji", emoji: "😁" }], updateId: 9, reactedAtUnix: 3 });
    expect(setMessageReaction).toHaveBeenCalledTimes(1);

    resolveFirst(true);
    await waitForIdle();
    await Promise.allSettled([first, latest, stale]);
    expect(setMessageReaction).toHaveBeenCalledTimes(2);
    expect(setMessageReaction).toHaveBeenNthCalledWith(
      2,
      -1001,
      10,
      [{ type: "emoji", emoji: "🔥" }],
      {},
      expect.any(AbortSignal)
    );
  });

  test("硬顶淘汰最旧的未开始任务并结算 waiter，不误删在途任务或最新任务", async () => {
    let releaseInFlight!: (value: boolean) => void;
    setMessageReaction.mockImplementationOnce(() => new Promise((resolve) => { releaseInFlight = resolve; }));
    const chatId: number = -1001;
    const inFlight: Promise<void> = enqueueReaction({ chatId, messageId: 0, reactions: [], updateId: 0, reactedAtUnix: 1 });
    expect(setMessageReaction).toHaveBeenCalledTimes(1);

    const queued: Promise<void>[] = [];
    for (let messageId: number = 1; messageId <= MAX_PENDING_TASKS_PER_CHAT + 1; messageId++) {
      queued.push(enqueueReaction({ chatId, messageId, reactions: [], updateId: messageId, reactedAtUnix: 1 }));
    }

    const droppedKey: string = `${chatId}:1`;
    await queued[0];
    expect(pendingTasks.has(droppedKey)).toBeFalse();
    expect(pendingReactionWaiters.has(droppedKey)).toBeFalse();
    expect(pendingTasks.has(`${chatId}:0`)).toBeTrue();
    expect(chatQueues.get(chatId)?.size).toBe(MAX_PENDING_TASKS_PER_CHAT);
    expect(pendingTasks.size).toBe(MAX_PENDING_TASKS_PER_CHAT + 1);
    expect(pendingTasks.has(`${chatId}:${MAX_PENDING_TASKS_PER_CHAT + 1}`)).toBeTrue();

    releaseInFlight(true);
    await Promise.allSettled([inFlight, ...queued]);
    await waitForIdle();

    expect(setMessageReaction).toHaveBeenCalledTimes(MAX_PENDING_TASKS_PER_CHAT + 1);
    expect(setMessageReaction.mock.calls.some((call) => call[0] === chatId && call[1] === 1)).toBeFalse();
    expect(setMessageReaction.mock.calls.some((call) =>
      call[0] === chatId && call[1] === MAX_PENDING_TASKS_PER_CHAT + 1
    )).toBeTrue();
    expect(pendingTasks.size).toBe(0);
    expect(pendingReactionWaiters.size).toBe(0);
    expect(chatQueues.size).toBe(0);
  });

  test("drain 在 API 在途时不提前成功，任务完成后结算", async () => {
    let release!: (value: boolean) => void;
    setMessageReaction.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const task = enqueueReaction({ chatId: -1001, messageId: 10, reactions: [], updateId: 1, reactedAtUnix: 1 });

    await expect(drainReactionQueue(1)).resolves.toBe("timedOut");
    release(true);
    await task;
    await expect(drainReactionQueue(100)).resolves.toBe("flushed");
  });

  test("429 按 retry_after 等待后重试，其它错误记录后放弃", async () => {
    setMessageReaction
      .mockRejectedValueOnce(new FakeGrammyError(429, { retry_after: 2 }))
      .mockResolvedValueOnce(true);
    enqueueReaction({ chatId: -1001, messageId: 10, reactions: [], updateId: 1, reactedAtUnix: 1 });
    await waitForIdle();
    expect(sleep).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining("retry 2/3"));
    expect(setMessageReaction).toHaveBeenCalledTimes(2);

    setMessageReaction.mockRejectedValueOnce(new Error("bad reaction"));
    enqueueReaction({ chatId: -1002, messageId: 20, reactions: [], updateId: 2, reactedAtUnix: 2 });
    await waitForIdle();
    expect(logApiError).toHaveBeenCalledWith("set message reaction", expect.any(Error));
    expect(pendingTasks.size).toBe(0);
  });

  test("停机预算耗尽会打断 429 sleep、清空队列且不再重试", async () => {
    setMessageReaction.mockRejectedValueOnce(new FakeGrammyError(429, { retry_after: 999_999 }));
    sleep.mockImplementationOnce(async (...args: unknown[]): Promise<void> => {
      const signal = args[1] as AbortSignal | undefined;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    enqueueReaction({ chatId: -1003, messageId: 30, reactions: [], updateId: 3, reactedAtUnix: 3 });
    await Bun.sleep(0);
    expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));

    quiesceReactionQueue();
    await expect(drainReactionQueue(1)).resolves.toBe("timedOut");
    await waitForIdle();

    expect(setMessageReaction).toHaveBeenCalledTimes(1);
    expect(pendingTasks.size).toBe(0);
    expect(pendingReactionWaiters.size).toBe(0);
    expect(reactionDrainWaiters.size).toBe(0);
  });
});
