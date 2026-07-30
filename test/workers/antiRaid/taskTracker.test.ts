import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  blocklistRemovalEpochs,
  blocklistRemovalTaskCounts,
} from "../../../packages/cache/workers/antiRaid/blocklist";
import { antiRaidInFlightTasks } from "../../../packages/cache/workers/antiRaid/tasks";
import {
  drainAntiRaidTasks,
  resetAntiRaidTaskTracker,
  trackAntiRaidTask,
} from "../../../packages/workers/antiRaid/taskTracker";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise: Promise<void> = new Promise<void>((done: () => void): void => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach((): void => resetAntiRaidTaskTracker());
afterEach((): void => resetAntiRaidTaskTracker());

describe("Anti-Raid async task tracker", () => {
  test("drain 会继续等待首项结算回调派生的新任务", async () => {
    const first: Deferred = deferred();
    const second: Deferred = deferred();
    const firstTask: Promise<void> = first.promise.then((): void => {
      void trackAntiRaidTask({ task: second.promise });
    });
    void trackAntiRaidTask({ task: firstTask });

    let drained: boolean = false;
    const drain: Promise<void> = drainAntiRaidTasks().then((): void => {
      drained = true;
    });
    first.resolve();
    await Bun.sleep(0);
    expect(drained).toBeFalse();
    expect(antiRaidInFlightTasks.size).toBe(1);

    second.resolve();
    await drain;
    expect(drained).toBeTrue();
    expect(antiRaidInFlightTasks.size).toBe(0);
  });

  test("stop 代际隔离旧 Promise，迟到结算不能清掉新 Worker 的同群状态", async () => {
    const oldTask: Deferred = deferred();
    void trackAntiRaidTask({ task: oldTask.promise, blocklistChatId: -1001 });
    blocklistRemovalEpochs.set(-1001, 1);

    resetAntiRaidTaskTracker();
    const newTask: Deferred = deferred();
    void trackAntiRaidTask({ task: newTask.promise, blocklistChatId: -1001 });
    blocklistRemovalEpochs.set(-1001, 7);
    oldTask.resolve();
    await Bun.sleep(0);

    expect(blocklistRemovalTaskCounts.get(-1001)).toBe(1);
    expect(blocklistRemovalEpochs.get(-1001)).toBe(7);
    newTask.resolve();
    await drainAntiRaidTasks();
    expect(blocklistRemovalTaskCounts.has(-1001)).toBeFalse();
    expect(blocklistRemovalEpochs.has(-1001)).toBeFalse();
  });
});
