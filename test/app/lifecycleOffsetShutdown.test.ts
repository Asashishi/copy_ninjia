import { describe, expect, test } from "bun:test";
import { FINAL_OFFSET_CONFIRM_TIMEOUT_MS } from "../../packages/consts/lifecycle";
import {
  installLifecycleFixtureHooks,
  lifecycleFixture as sharedFixture,
} from "../helpers/lifecycleFixture";
import type { FlushResult } from "../helpers/lifecycleFixture";

const {
  ApplicationLifecycle,
  advanceMonotonicTime,
  calls,
  closeTranslate,
  deferred,
  drainAntiRaid,
  drainTelegramOutbound,
  flushAiMemory,
  flushDiskIO,
  flushStateToDisk,
  getUpdates,
  loggerError,
  refreshAllChatTitles,
  releaseSingleInstanceLock,
  runnerAbortActive,
  runnerHasFailedUpdate,
  runnerSize,
  setLastSeenUpdateId,
  sleep,
  testDependencies,
} = sharedFixture;

installLifecycleFixtureHooks();

describe("应用最终 offset 确认与排空", () => {
  test("正常 wait 会等待 runner 排空并确认最后 update offset", async () => {
    runnerSize.mockReturnValueOnce(1).mockReturnValue(0);
    setLastSeenUpdateId(321);
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();
    await lifecycle.dispose();

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(getUpdates).toHaveBeenCalledWith(
      { offset: 322, limit: 1, timeout: 0 },
      expect.any(AbortSignal)
    );
    expect(flushAiMemory).toHaveBeenCalledTimes(2);
    expect(flushDiskIO).toHaveBeenCalledTimes(2);
    expect(flushStateToDisk).toHaveBeenCalledTimes(2);
    expect(closeTranslate).toHaveBeenCalledTimes(1);
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("wait 在 Anti-Raid drain 完成前不得 flush，更不得确认 offset", async () => {
    const antiRaidGate = deferred<FlushResult>();
    drainAntiRaid.mockImplementationOnce(() => {
      calls.push("drainAntiRaid");
      return antiRaidGate.promise;
    });
    setLastSeenUpdateId(654);
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    const waiting = lifecycle.wait();
    await Bun.sleep(0);

    expect(drainAntiRaid).toHaveBeenCalledTimes(1);
    expect(flushAiMemory).not.toHaveBeenCalled();
    expect(flushDiskIO).not.toHaveBeenCalled();
    expect(flushStateToDisk).not.toHaveBeenCalled();
    expect(getUpdates).not.toHaveBeenCalled();

    antiRaidGate.resolve("flushed");
    await waiting;

    expect(calls.indexOf("drainAntiRaid")).toBeLessThan(calls.indexOf("flushAiMemory"));
    expect(calls.indexOf("flushAiMemory")).toBeLessThan(calls.indexOf("flushDiskIO"));
    expect(calls.indexOf("flushDiskIO")).toBeLessThan(calls.indexOf("flushState"));
    expect(calls.indexOf("flushState")).toBeLessThan(calls.indexOf("getUpdates"));
    expect(getUpdates).toHaveBeenCalledWith(
      { offset: 655, limit: 1, timeout: 0 },
      expect.any(AbortSignal)
    );
    await lifecycle.dispose();
  });

  test("最终 offset 确认失败会非零退出并点名 offset，但不扣住实例锁", async () => {
    setLastSeenUpdateId(432);
    getUpdates.mockRejectedValueOnce(new Error("confirmation failed"));
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();
    await lifecycle.dispose();

    expect(process.exitCode).toBe(1);
    expect(loggerError).toHaveBeenCalledWith(
      "Failed to confirm update offset on shutdown:",
      expect.any(Error)
    );
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("offset=false"));
    // offsetWithheld 档：各 owner 都排空落盘、Worker 已终止，没有任何东西还会写
    // 共享数据目录，扣住锁只会留下一条陈旧 bot.lock 记录并误导排查方向。
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("永不自行 settle 的最终确认受专用 AbortSignal 截断", async () => {
    setLastSeenUpdateId(543);
    const originalTimeout: typeof AbortSignal.timeout = AbortSignal.timeout;
    let requestedTimeoutMs: number | undefined;
    AbortSignal.timeout = ((timeoutMs: number): AbortSignal => {
      requestedTimeoutMs = timeoutMs;
      return AbortSignal.abort(new DOMException("confirmation timed out", "TimeoutError"));
    }) as typeof AbortSignal.timeout;
    getUpdates.mockImplementationOnce(async (
      _params?: { offset: number; limit: number; timeout: number },
      signal?: AbortSignal
    ): Promise<unknown[]> => {
      calls.push("getUpdates");
      if (signal?.aborted === true) throw signal.reason;
      return new Promise<unknown[]>(() => {});
    });
    const lifecycle = new ApplicationLifecycle(testDependencies);

    try {
      await lifecycle.init();
      await lifecycle.wait();
      await lifecycle.dispose();
    } finally {
      AbortSignal.timeout = originalTimeout;
    }

    expect(requestedTimeoutMs).toBe(FINAL_OFFSET_CONFIRM_TIMEOUT_MS);
    expect(process.exitCode).toBe(1);
    // 同上：确认超时属于 offsetWithheld，不是「还有人在写」，锁照常释放。
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("wait 首次维护超时后即使 dispose 时落定也不能改写未确认结果", async () => {
    const maintenance = deferred<void>();
    refreshAllChatTitles.mockImplementationOnce((): Promise<void> => maintenance.promise);
    setLastSeenUpdateId(654);
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
    const originalClearTimeout: typeof clearTimeout = globalThis.clearTimeout;
    const timeoutToken = {} as ReturnType<typeof setTimeout>;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void): ReturnType<typeof setTimeout> => {
      queueMicrotask(callback);
      return timeoutToken;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((_timer: ReturnType<typeof setTimeout>): void => {}) as typeof clearTimeout;
    try {
      await lifecycle.wait();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }

    maintenance.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await lifecycle.dispose();

    expect(getUpdates).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("offset=false"));
    // 迟到落定改写不了 offset 结论（上一条断言），但它确实证明了那个维护任务
    // 已经结束：dispose 自己那轮 waitForBackgroundMaintenance 因此是 settled，
    // 三态落在 offsetWithheld，锁可以释放。维护任务若到 dispose 仍未落定，
    // dispose 那轮同样会超时，三态变成 unsettled，锁才扣住。
    expect(releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
  });

  test("确认前 Anti-Raid drain 超时会阻止 offset，并把失败传播到退出状态", async () => {
    setLastSeenUpdateId(777);
    drainAntiRaid.mockResolvedValueOnce("timedOut");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();

    expect(process.exitCode).toBe(1);
    expect(getUpdates).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("antiRaid=timedOut"));
    await lifecycle.dispose();
  });

  test("回归：确认 offset 前的排空不关闭出站闸门，只有 dispose 那一遍才关", async () => {
    // 关早了的话，dispose() 里 gag 提示、延迟删除与 anti-raid 的重试全部只会
    // 拿到 AbortError：提示永远留在群里，owner 永远结算不掉、锁也就扣着不放。
    setLastSeenUpdateId(555);
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();
    expect(drainTelegramOutbound).toHaveBeenCalledTimes(1);
    expect(drainTelegramOutbound).toHaveBeenLastCalledWith(expect.any(Number), { quiesce: false });

    await lifecycle.dispose();
    expect(drainTelegramOutbound).toHaveBeenCalledTimes(2);
    expect(drainTelegramOutbound).toHaveBeenLastCalledWith(expect.any(Number), { quiesce: true });
    // gag 与延迟删除的最后一次重试仍排在关闸之前。
    expect(calls.lastIndexOf("drainGag")).toBeLessThan(calls.lastIndexOf("drainTelegramOutbound"));
    expect(calls.lastIndexOf("drainMessageDeletions")).toBeLessThan(calls.lastIndexOf("drainTelegramOutbound"));
  });

  test("确认前 Telegram 总闸未排空时扣住 offset，重启后由 durable owner 重放", async () => {
    setLastSeenUpdateId(778);
    drainTelegramOutbound.mockResolvedValueOnce("timedOut");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();

    expect(getUpdates).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("telegram=timedOut"));
    await lifecycle.dispose();
  });

  test("确认前任一持久化边界失败时不确认 update offset", async () => {
    setLastSeenUpdateId(321);
    flushDiskIO.mockResolvedValueOnce("failed");
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();
    await lifecycle.dispose();

    expect(getUpdates).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("final Telegram update offset will not be confirmed"));
  });

  test("停机时有 update 处理失败：不确认 offset 并以非零状态退出", async () => {
    // 停机路径放弃在途批次后 task() 会正常 resolve，排空也会归零，光靠这两者
    // 无法发现那批里失败的 update。漏掉就等于替 Telegram 确认了一条从未成功
    // 处理的 update，重启后不会再收到它。
    setLastSeenUpdateId(888);
    runnerHasFailedUpdate.mockReturnValue(true);
    const lifecycle = new ApplicationLifecycle(testDependencies);
    await lifecycle.init();

    await lifecycle.wait();

    expect(getUpdates).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Withholding the final Telegram offset")
    );
    await lifecycle.dispose();
  });

  test("墙钟回拨时排空仍按单调预算超时，且不确认 offset", async () => {
    let wallNow: number = 1_000;
    const originalDateNow = Date.now;
    Date.now = (): number => wallNow;
    runnerSize.mockReturnValue(2);
    sleep.mockImplementation(async (): Promise<void> => {
      wallNow -= 60_000;
      advanceMonotonicTime(5_000);
    });
    setLastSeenUpdateId(321);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    try {
      await lifecycle.init();
      await lifecycle.wait();
      await lifecycle.dispose();
    } finally {
      Date.now = originalDateNow;
    }

    expect(getUpdates).not.toHaveBeenCalled();
    expect(runnerAbortActive).toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("withholding their Telegram offset"));
  });

  test("并发 update 乱序完成时不会跨过仍在途的较小 update", async () => {
    // 较大的 update 已经完成，但较小的 update 仍占据 runner，因此 size 始终非零。
    runnerSize.mockReturnValue(1);
    sleep.mockImplementation(async (): Promise<void> => { advanceMonotonicTime(5_000); });
    setLastSeenUpdateId(900);
    const lifecycle = new ApplicationLifecycle(testDependencies);

    await lifecycle.init();
    await lifecycle.wait();
    await lifecycle.dispose();

    expect(getUpdates).not.toHaveBeenCalled();
  });
});
