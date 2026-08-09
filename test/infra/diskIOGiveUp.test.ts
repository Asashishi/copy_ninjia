import { describe, expect, spyOn, test } from "bun:test";
import type { DiskIOMessage, DiskIOReply } from "../../packages/types";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { WORKER_MAX_RESTARTS } from "../../packages/consts/workerSupervisor";

/**
 * 放弃自愈这条路必须独占一个测试文件：`diskIORestartThrottle` 是模块级滑动窗口，
 * 走完这条路就把配额用光了，同文件里任何还指望 Worker 重建的用例都会连坐失败
 * （随机顺序下尤其明显）。`bun test --isolate` 按文件重建模块注册表，分文件即隔离。
 */

const diskIO = await import("../../packages/infra/diskIO");

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<DiskIOReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: DiskIOMessage[] = [];
  terminated: boolean = false;

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  unref(): void {}

  postMessage(message: DiskIOMessage): void {
    this.messages.push(message);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

function emitSuccessfulLoad(worker: FakeWorker): void {
  worker.onmessage!({ data: {
    type: "loaded",
    aiMemories: new Map(),
    stickerCatalogs: new Map(),
    luckDay: null,
    luckReceiptSecret: {
      version: 1 as const,
      day: "2026-07-19",
      key: Buffer.alloc(32, 7).toString("base64url"),
    },
    verifications: new Map(),
    blockedUsers: new Map(),
    pendingBlockedRemovals: new Map(),
  } } as MessageEvent<DiskIOReply>);
}

describe("Disk I/O Worker 放弃自愈", () => {
  test("回归：通知 give-up 订阅方，让各领域立刻按失败结算", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fatalErrors: Error[] = [];
    try {
      diskIO.initDiskIO({ onFatal: (fatal: Error) => { fatalErrors.push(fatal); } });
      const first: FakeWorker = FakeWorker.instances[0]!;
      const loadedPromise = diskIO.loadPersistedData(1_000);
      emitSuccessfulLoad(first);
      await loadedPromise;

      // 放弃之后没有替补 Worker：onDiskIORespawn 不会跑，还在等 durable 回执的
      // owner（典型是 AI 记忆删除 waiter）不会再等到任何回执，只能靠这条通知
      // 立刻失败，而不是各自干等自己那份超时——那段干等恰好和同一个 fatal 信号
      // 触发的停机抢排空预算。
      let notified: number = 0;
      diskIO.onDiskIOGiveUp((): void => { notified++; });

      // 耗尽重启预算：最后一次崩溃走放弃分支。
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
      globalThis.Worker = originalWorker;
    }
  });
});
