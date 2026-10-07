import { describe, expect, spyOn, test } from "bun:test";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { WORKER_MAX_RESTARTS } from "../../packages/consts/workerSupervisor";
import {
  emitSuccessfulDiskIOLoad as emitSuccessfulLoad,
  FakeDiskIOWorker as FakeWorker,
  installFakeDiskIOWorker,
} from "../helpers/diskIOWorkerHarness";

/**
 * 放弃自愈这条路独占一个测试文件：`diskIORestartThrottle` 是模块级滑动窗口，走完这条路就把配额用光；
 * `bun test --isolate` 按文件重建模块注册表，分文件即隔离。
 */

const diskIO = await import("../../packages/infra/diskIO");

describe("Disk I/O Worker 放弃自愈", () => {
  test("回归：通知 give-up 订阅方，让各领域立刻按失败结算", async () => {
    const restoreWorker: () => void = installFakeDiskIOWorker();
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fatalErrors: Error[] = [];
    try {
      diskIO.initDiskIO({ onFatal: (fatal: Error) => { fatalErrors.push(fatal); } });
      const first: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(first);
      await loadedPromise;

      // 放弃之后没有替补 Worker：onDiskIORespawn 不会跑，还在等 durable 回执的 owner（如 AI 记忆删除 waiter）
      // 靠这条通知立刻失败。
      let notified: number = 0;
      diskIO.onDiskIOGiveUp((): void => { notified++; });

      // 普通崩溃继续沿用共享 Worker 的滑动窗口预算。
      for (let attempt: number = 0; attempt <= WORKER_MAX_RESTARTS; attempt++) {
        FakeWorker.instances.at(-1)?.onerror!({ message: "runtime crash" } as ErrorEvent);
        if (diskIORuntime.worker === null) break;
        emitSuccessfulLoad(FakeWorker.instances.at(-1)!);
      }

      expect(diskIORuntime.worker).toBeNull();
      expect(fatalErrors).toHaveLength(1);
      expect(notified).toBe(1);
    } finally {
      await diskIO.terminateDiskIO();
      error.mockRestore();
      restoreWorker();
    }
  });
});
