import { describe, expect, test } from "bun:test";
import { withTimeout } from "../../packages/libs/withTimeout";

/**
 * 超时竞速的三条语义都要钉住：超时以约定文案拒绝、底层任务不被取消、
 * 两侧任一先结算都要清掉 timer 且那个 timer 必须是 unref 的。
 * 前两条是调用方 catch 分支的前提，后一条决定它会不会把进程留在事件循环里。
 */

/** 记录本次调用建立的 timer 有没有被 unref / clearTimeout。 */
function trackTimers(): {
  restore: () => void;
  unrefCount: () => number;
  clearCount: () => number;
} {
  const originalSetTimeout: typeof setTimeout = globalThis.setTimeout;
  const originalClearTimeout: typeof clearTimeout = globalThis.clearTimeout;
  let unrefCount: number = 0;
  let clearCount: number = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...args);
    const originalUnref = timer.unref.bind(timer);
    timer.unref = (): typeof timer => {
      unrefCount++;
      return originalUnref();
    };
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]): void => {
    clearCount++;
    originalClearTimeout(timer);
  }) as typeof clearTimeout;
  return {
    restore: (): void => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
    unrefCount: (): number => unrefCount,
    clearCount: (): number => clearCount,
  };
}

describe("withTimeout 超时竞速", () => {
  test("超时以约定文案拒绝，且不打断底层任务", async () => {
    let settledAfterTimeout: boolean = false;
    const task = new Promise<string>((resolve) => {
      setTimeout((): void => {
        settledAfterTimeout = true;
        resolve("late");
      }, 60).unref();
    });

    await expect(withTimeout(task, 5, "disk flush")).rejects.toThrow(
      "disk flush timed out after 5ms"
    );
    // 超时只结束调用方的等待；本函数不负责取消，底层任务照常跑完。
    await expect(task).resolves.toBe("late");
    expect(settledAfterTimeout).toBeTrue();
  });

  test("任务先结算时原样透传取值，并清掉超时 timer", async () => {
    const timers = trackTimers();
    try {
      await expect(withTimeout(Promise.resolve(42), 60_000, "fast")).resolves.toBe(42);
      expect(timers.clearCount()).toBe(1);
    } finally {
      timers.restore();
    }
  });

  test("任务先拒绝时原样透传该错误，不换成超时错误", async () => {
    const failure = new Error("task exploded");
    await expect(withTimeout(Promise.reject(failure), 60_000, "fast")).rejects.toBe(failure);
  });

  test("超时 timer 一律 unref，长预算不会把进程钉在事件循环里", async () => {
    const timers = trackTimers();
    try {
      await withTimeout(Promise.resolve("ok"), 3_600_000, "long budget");
      expect(timers.unrefCount()).toBe(1);
      expect(timers.clearCount()).toBe(1);
    } finally {
      timers.restore();
    }
  });

  test("零预算立刻超时，仍走同一条文案", async () => {
    await expect(
      withTimeout(new Promise<never>((): void => undefined), 0, "zero budget")
    ).rejects.toThrow("zero budget timed out after 0ms");
  });
});
