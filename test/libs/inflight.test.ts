import { describe, expect, test } from "bun:test";
import { settleInflight, settleWithinBudget, trackInflight } from "../../packages/libs/inflight";
import { deferred } from "./helpers";

describe("inflight tracker", () => {
  test("settle 会等待被较新请求掩盖不了的所有旧请求", async () => {
    const inflight = new Set<Promise<unknown>>();
    const older = deferred();
    const newer = deferred();
    trackInflight(inflight, older.promise);
    trackInflight(inflight, newer.promise);

    let settled = false;
    const waiting = settleInflight(inflight).then(() => {
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

  test("某个请求 reject 不会让 settle 提前返回，仍等其余在途请求落定", async () => {
    const inflight = new Set<Promise<unknown>>();
    const pending = deferred();
    const failing = Promise.reject(new Error("boom"));
    trackInflight(inflight, failing).catch(() => {});
    trackInflight(inflight, pending.promise);

    let settled = false;
    const waiting = settleInflight(inflight).then(() => {
      settled = true;
    });

    // reject 已经发生，若 settle 用的是 Promise.all 会在这里提前失败返回。
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
    const first = deferred();
    const later = deferred();
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
