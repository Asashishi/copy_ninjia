import { afterEach, describe, expect, jest, test } from "bun:test";
import { Glob } from "bun";
import {
  diskIOOperationCount,
  diskIOOperationTail,
} from "../../../packages/cache/workers/diskIO/recovery";
import {
  dueTimedDiskIOOperations,
  timedDiskIOOperationState,
} from "../../../packages/cache/workers/diskIO/timedFlush";
import { DISK_WORKER_MAX_QUEUED_OPERATIONS } from "../../../packages/consts/diskIO/business";
import { enqueueDiskIOOperation } from "../../../packages/workers/diskIO/operationQueue";
import {
  armDiskIOFlushTimer,
  cancelDiskIOFlushTimer,
  queueTimedDiskIOOperation,
} from "../../../packages/workers/diskIO/timedFlush";
import type { FlushTimerSlot } from "../../../packages/types/diskIO/storage";

/** 占住统一操作队列的队首，直到返回的 release 被调用。 */
function holdOperationQueue(): { release: () => void; held: Promise<void> } {
  let release: (() => void) | undefined;
  const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
    release = resolve;
  });
  const held: Promise<void> = enqueueDiskIOOperation((): Promise<void> => gate);
  return { release: release!, held };
}

afterEach(() => {
  jest.useRealTimers();
  dueTimedDiskIOOperations.clear();
  timedDiskIOOperationState.queued = false;
  diskIOOperationTail.current = Promise.resolve();
  diskIOOperationCount.current = 0;
});

describe("Disk I/O 定时操作合并入队", () => {
  test("队列被占住时，超过队列上限的定时来源也只占一个队列位置", async () => {
    const { release } = holdOperationQueue();
    const order: number[] = [];
    const sources: number = DISK_WORKER_MAX_QUEUED_OPERATIONS + 2;
    for (let index: number = 0; index < sources; index++) {
      queueTimedDiskIOOperation((): void => {
        order.push(index);
      });
    }
    expect(diskIOOperationCount.current).toBe(2);
    expect(dueTimedDiskIOOperations.size).toBe(sources);

    release();
    await diskIOOperationTail.current;
    expect(order).toEqual(Array.from({ length: sources }, (_: unknown, index: number): number => index));
    expect(dueTimedDiskIOOperations.size).toBe(0);
    expect(timedDiskIOOperationState.queued).toBe(false);
    expect(diskIOOperationCount.current).toBe(0);
  });

  test("执行期间新到点的操作并入同一轮，不再占第二个队列位置", async () => {
    const order: string[] = [];
    let countDuringFirst: number | undefined;
    const second = (): void => {
      order.push("second");
    };
    queueTimedDiskIOOperation(async (): Promise<void> => {
      order.push("first");
      queueTimedDiskIOOperation(second);
      countDuringFirst = diskIOOperationCount.current;
      await Promise.resolve();
    });
    await diskIOOperationTail.current;
    expect(order).toEqual(["first", "second"]);
    expect(countDuringFirst).toBe(1);
    expect(timedDiskIOOperationState.queued).toBe(false);
  });

  test("同一操作在执行前重复登记只执行一次，执行后再登记会再执行", async () => {
    let runs: number = 0;
    const operation = (): void => {
      runs++;
    };
    queueTimedDiskIOOperation(operation);
    queueTimedDiskIOOperation(operation);
    await diskIOOperationTail.current;
    expect(runs).toBe(1);

    queueTimedDiskIOOperation(operation);
    await diskIOOperationTail.current;
    expect(runs).toBe(2);
  });

  test("操作拒绝时合并操作一并拒绝，并复位排队标记", async () => {
    queueTimedDiskIOOperation((): never => {
      throw new Error("injected timed operation failure");
    });
    await expect(diskIOOperationTail.current).rejects.toThrow("injected timed operation failure");
    expect(timedDiskIOOperationState.queued).toBe(false);
  });
});

describe("Disk I/O flush timer 槽位", () => {
  test("已装时不重复装；触发时先清空槽位再登记操作", async () => {
    jest.useFakeTimers();
    const slot: FlushTimerSlot = { timer: null };
    let slotDuringRun: FlushTimerSlot["timer"] | undefined;
    let runs: number = 0;
    const operation = (): void => {
      slotDuringRun = slot.timer;
      runs++;
    };
    armDiskIOFlushTimer(slot, 1_000, operation);
    const armed: FlushTimerSlot["timer"] = slot.timer;
    expect(armed).not.toBeNull();
    armDiskIOFlushTimer(slot, 1_000, operation);
    expect(slot.timer).toBe(armed);

    jest.advanceTimersByTime(1_000);
    expect(slot.timer).toBeNull();
    await diskIOOperationTail.current;
    expect(runs).toBe(1);
    expect(slotDuringRun).toBeNull();
  });

  test("取消后不再触发，槽位空闲时取消幂等", async () => {
    jest.useFakeTimers();
    const slot: FlushTimerSlot = { timer: null };
    let runs: number = 0;
    armDiskIOFlushTimer(slot, 1_000, (): void => {
      runs++;
    });
    cancelDiskIOFlushTimer(slot);
    expect(slot.timer).toBeNull();
    cancelDiskIOFlushTimer(slot);
    jest.advanceTimersByTime(1_000);
    await diskIOOperationTail.current;
    expect(runs).toBe(0);
    expect(timedDiskIOOperationState.queued).toBe(false);
  });
});

test("Disk I/O Worker 内只有消息入口、每日维护与定时合并边界直接入队", async () => {
  const allowed: ReadonlySet<string> = new Set([
    "packages/workers/diskIO/maintenanceCron.ts",
    "packages/workers/diskIO/operationQueue.ts",
    "packages/workers/diskIO/timedFlush.ts",
    "packages/workers/diskIOWorker.ts",
  ]);
  const offenders: string[] = [];
  for await (const path of new Glob("packages/**/*.ts").scan(".")) {
    if (allowed.has(path)) continue;
    if ((await Bun.file(path).text()).includes("enqueueDiskIOOperation(")) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});
