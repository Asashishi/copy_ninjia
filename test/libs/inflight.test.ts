import { describe, expect, test } from "bun:test";
import { assertTimeoutMs, drainTrackedTasks, settleWithinBudget, trackInflight } from "../../packages/libs/inflight";

describe("inflight tracker", () => {
  test("按本体登记的旧请求不会被较新请求掩盖，等待登记集合时仍会等它", async () => {
    const inflight = new Set<Promise<unknown>>();
    const older: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const newer: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    trackInflight(inflight, older.promise);
    trackInflight(inflight, newer.promise);

    let settled = false;
    const waiting = Promise.allSettled(inflight).then(() => {
      settled = true;
    });

    newer.resolve();
    await newer.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(inflight.size).toBe(1);

    older.resolve();
    await waiting;
    expect(settled).toBe(true);
    expect(inflight.size).toBe(0);
  });

  test("某个登记请求 reject 后，allSettled 仍等其余在途请求落定", async () => {
    const inflight = new Set<Promise<unknown>>();
    const pending: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const failing = Promise.reject(new Error("boom"));
    trackInflight(inflight, failing).catch(() => {});
    trackInflight(inflight, pending.promise);

    let settled = false;
    const waiting = Promise.allSettled(inflight).then(() => {
      settled = true;
    });

    // reject 已经发生，若等待用的是 Promise.all 会在这里提前失败返回。
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(inflight.size).toBe(1);

    pending.resolve();
    await waiting;
    expect(settled).toBe(true);
    expect(inflight.size).toBe(0);
  });
});

describe("有界在途等待", () => {
  test("空集合在零预算下完成", async () => {
    expect(await settleWithinBudget([], 0)).toBe(true);
  });

  test("失败任务不提前结束等待，只等待调用时的任务快照", async () => {
    const first: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const later: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const tasks = new Set<Promise<unknown>>([Promise.reject(new Error("failed")), first.promise]);
    let settled: boolean = false;
    const waiting = settleWithinBudget(tasks, 1_000).then((result: boolean): boolean => {
      settled = true;
      return result;
    });
    tasks.add(later.promise);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    first.resolve();
    expect(await waiting).toBe(true);
    later.resolve();
  });

  test("超时不取消任务，迟到失败仍被观察", async () => {
    const pending = Promise.withResolvers<void>();
    expect(await settleWithinBudget([pending.promise], 5)).toBe(false);
    pending.reject(new Error("late failure"));
    await Promise.resolve();
  });
});

describe("排空预算与在途任务排空", () => {
  test("assertTimeoutMs 只接受非负有限毫秒数，报错带预算名", () => {
    for (const budget of [0, 1, 5_000]) expect((): void => assertTimeoutMs(budget, "Test drain timeout")).not.toThrow();
    for (const budget of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect((): void => assertTimeoutMs(budget, "Test drain timeout")).toThrow(
        new RangeError("Test drain timeout must be a non-negative finite number.")
      );
    }
  });

  test("没有在途任务时直接 flushed，不 abort", async () => {
    const controller: AbortController = new AbortController();
    expect(await drainTrackedTasks(new Set(), controller, 0)).toBe("flushed");
    expect(controller.signal.aborted).toBeFalse();
  });

  test("预算内结算（含失败）为 flushed；零预算或超时先 abort 再 timedOut", async () => {
    const settled: AbortController = new AbortController();
    const failing: Promise<void> = Promise.reject(new Error("expected"));
    failing.catch((): void => {});
    expect(await drainTrackedTasks(new Set([failing]), settled, 1_000)).toBe("flushed");
    expect(settled.signal.aborted).toBeFalse();

    const pending: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const zero: AbortController = new AbortController();
    expect(await drainTrackedTasks(new Set([pending.promise]), zero, 0)).toBe("timedOut");
    expect(zero.signal.aborted).toBeTrue();

    const expired: AbortController = new AbortController();
    expect(await drainTrackedTasks(new Set([pending.promise]), expired, 1)).toBe("timedOut");
    expect(expired.signal.aborted).toBeTrue();
    pending.resolve();
  });
});
