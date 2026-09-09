import { describe, expect, test } from "bun:test";
import { drainWithWaiter } from "../../packages/libs/drainWaiter";
import type { FlushResult } from "../../packages/types/lifecycle";

/**
 * 停机 drain 骨架的两条易错语义（见 libs/drainWaiter.ts 的模块头注）：
 * **预算为 0 时不抛校验错、而是立刻 abort 并按 timedOut 结算**，以及
 * 「登记 waiter 之后必须再触发一次空闲检查」那道补漏。两条都只有在这里被直接
 * 钉住；新增 owner 复用同一个函数，不该在调用点各写一份。
 */

interface Harness {
  readonly waiters: Set<() => void>;
  readonly abortCalls: () => number;
  readonly notifyCalls: () => number;
  readonly drain: (timeoutMs: number) => Promise<FlushResult>;
  setIdle: (value: boolean) => void;
}

/** 建一个可控 owner：空闲判定、waiter 集合与两个副作用计数都由用例驱动。 */
function harness(initiallyIdle: boolean, notifyBecomesIdle: boolean = false): Harness {
  const waiters = new Set<() => void>();
  let idle: boolean = initiallyIdle;
  let abortCalls: number = 0;
  let notifyCalls: number = 0;
  return {
    waiters,
    abortCalls: (): number => abortCalls,
    notifyCalls: (): number => notifyCalls,
    setIdle: (value: boolean): void => { idle = value; },
    drain: (timeoutMs: number): Promise<FlushResult> => drainWithWaiter({
      owner: "avatar",
      timeoutMs,
      isIdle: (): boolean => idle,
      waiters,
      notifyIfIdle: (): void => {
        notifyCalls++;
        // 覆盖「登记 waiter」与「owner 恰好转为空闲」之间那道缝：真实 owner 在
        // 这一刻已经空闲，只是最后一个任务的结算跑在登记之前。
        if (notifyBecomesIdle) for (const waiter of [...waiters]) waiter();
      },
      abort: (): void => { abortCalls++; },
    }),
  };
}

describe("drainWithWaiter 停机排空骨架", () => {
  test("已经空闲时同步结算 flushed，不登记 waiter 也不 abort", async () => {
    const owner = harness(true);
    await expect(owner.drain(1_000)).resolves.toBe("flushed");
    expect(owner.waiters.size).toBe(0);
    expect(owner.notifyCalls()).toBe(0);
    expect(owner.abortCalls()).toBe(0);
  });

  test("非法预算按 owner 名抛 RangeError，且先于空闲判定", () => {
    const owner = harness(true);
    expect((): Promise<FlushResult> => owner.drain(-1)).toThrow(RangeError);
    expect((): Promise<FlushResult> => owner.drain(-1)).toThrow("avatar drain timeout");
    expect((): Promise<FlushResult> => owner.drain(Number.NaN)).toThrow(RangeError);
    expect((): Promise<FlushResult> => owner.drain(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test("预算为 0 且未空闲时 abort 并按 timedOut 结算，不抛校验错", async () => {
    const owner = harness(false);
    await expect(owner.drain(0)).resolves.toBe("timedOut");
    expect(owner.abortCalls()).toBe(1);
    // 没有可等待的窗口，因此既不登记 waiter 也不触发空闲检查。
    expect(owner.waiters.size).toBe(0);
    expect(owner.notifyCalls()).toBe(0);
  });

  test("owner 在预算内转为空闲时结算 flushed，并摘掉自己那个 waiter", async () => {
    const owner = harness(false);
    const pending: Promise<FlushResult> = owner.drain(5_000);
    expect(owner.waiters.size).toBe(1);
    expect(owner.notifyCalls()).toBe(1);

    for (const waiter of [...owner.waiters]) waiter();
    await expect(pending).resolves.toBe("flushed");
    expect(owner.waiters.size).toBe(0);
    expect(owner.abortCalls()).toBe(0);
  });

  test("登记与转为空闲撞在一起时靠 notifyIfIdle 补漏，不必等满预算", async () => {
    const owner = harness(false, true);
    await expect(owner.drain(3_600_000)).resolves.toBe("flushed");
    expect(owner.waiters.size).toBe(0);
    expect(owner.abortCalls()).toBe(0);
  });

  test("预算耗尽时先 abort 再结算 timedOut，随后迟到的空闲回调不改写结果", async () => {
    const owner = harness(false);
    const pending: Promise<FlushResult> = owner.drain(5);
    await expect(pending).resolves.toBe("timedOut");
    expect(owner.abortCalls()).toBe(1);
    expect(owner.waiters.size).toBe(0);

    // 迟到的空闲回调此时已被摘除；owner 事后再排空一次也不会二次结算。
    for (const waiter of [...owner.waiters]) waiter();
    await expect(pending).resolves.toBe("timedOut");
    expect(owner.abortCalls()).toBe(1);
  });
});
