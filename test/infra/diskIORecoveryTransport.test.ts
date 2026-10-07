/**
 * Disk I/O 恢复握手里 scoped transport 与失败收口的各条错误路径。
 *
 * 这些分支只在「上一代 Worker 已经死了、新一代还在恢复握手中」这个窗口里到得了：
 * 镜像重放拿不到运势密钥、重放消息投不出去、新代际连 load 都收不下、终止旧实例本身又失败。
 *
 * 代际操纵靠 helpers/diskIOWorkerHarness.ts：`crashDiskIOWorker` 造出「正在恢复的代际」，
 * `FakeDiskIOWorker.nextRejectedTypes` / `nextTerminateBehavior` 预置那个由宿主自己 new 出来、调用方碰不到的替身。
 */

import { describe, expect, spyOn, test } from "bun:test";
import {
  diskIOFlushBarrier,
  diskIORestartThrottle,
  diskIORuntime,
} from "../../packages/cache/main/diskIO";
import {
  DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES,
} from "../../packages/consts/diskIO/diagnostics";
import type { DiskIOMessage, DiskIORecoveryTransport, DiskIORespawnListener, LuckDrawDiskMessage } from "../../packages/types/diskIO/messages";
import type { DiskIOReply } from "../../packages/types/diskIO/replies";
import {
  crashDiskIOWorker,
  emitDiskIOLuckSecretReply,
  emitSuccessfulDiskIOLoad as emitSuccessfulLoad,
  FakeDiskIOWorker as FakeWorker,
  installFakeDiskIOWorker,
  lastDiskIOMessage,
  TEST_LUCK_RECEIPT_SECRET as luckReceiptSecret,
} from "../helpers/diskIOWorkerHarness";

const diskIO = await import("../../packages/infra/diskIO");

const luckDraw: LuckDrawDiskMessage = {
  type: "luckDraw",
  day: "2026-07-19",
  key: "42",
  label: "大吉",
  fortunePercent: 99,
};

/**
 * 只留本用例这一个恢复监听器，跑完原样放回。
 *
 * 整表替换而不是追加：生产监听器也会在同一次握手里跑，这里只保留本用例的监听器。
 */
function withOnlyRespawnListener(listener: DiskIORespawnListener): () => void {
  const saved: typeof diskIORuntime.respawnListeners = [...diskIORuntime.respawnListeners];
  diskIORuntime.respawnListeners.length = 0;
  diskIO.onDiskIORespawn("recovery transport test", 1, listener);
  return (): void => {
    diskIORuntime.respawnListeners.splice(
      0,
      diskIORuntime.respawnListeners.length,
      ...saved
    );
  };
}

interface RecoveryFixture {
  readonly first: FakeWorker;
  readonly fatals: Error[];
  readonly consoleError: ReturnType<typeof spyOn<Console, "error">>;
  dispose(): Promise<void>;
}

/**
 * 装好替身、跑完首次 load、进入可写稳态；返回第一代替身与清理钩子。
 *
 * 顺带把重启节流按下：`diskIORestartThrottle` 是模块级滑动窗口，只允许 WORKER_MAX_RESTARTS 次重建，
 * 而本文件每条用例都要现造一个「正在恢复的代际」。放弃自愈那条路由 diskIOGiveUp.test.ts 独占。
 */
async function startDiskIO(options: { readonly onFatal?: boolean } = {}): Promise<RecoveryFixture> {
  const restoreWorker: () => void = installFakeDiskIOWorker();
  const consoleError = spyOn(console, "error").mockImplementation((): void => {});
  const throttle = spyOn(diskIORestartThrottle, "shouldGiveUp").mockReturnValue(false);
  const fatals: Error[] = [];
  diskIO.initDiskIO(options.onFatal === false
    ? {}
    : { onFatal: (fatal: Error): void => { fatals.push(fatal); } });
  const first: FakeWorker = FakeWorker.instances[0]!;
  const loaded: Promise<unknown> = diskIO.loadPersistedData(1_000);
  emitSuccessfulLoad(first);
  await loaded;
  await Bun.sleep(0);
  return {
    first,
    fatals,
    consoleError,
    dispose: async (): Promise<void> => {
      await diskIO.terminateDiskIO();
      throttle.mockRestore();
      consoleError.mockRestore();
      restoreWorker();
    },
  };
}

describe("Disk I/O 恢复握手的 scoped transport", () => {
  test("代际在请求发出前就翻了：投递与取密钥都当场失败，不碰已死的那一代", async () => {
    const fixture: RecoveryFixture = await startDiskIO();
    let posted: boolean = true;
    let secretError: string = "";
    const restoreListeners: () => void = withOnlyRespawnListener(
      async (transport: DiskIORecoveryTransport): Promise<boolean> => {
        // 重放刚开始，第二代就又崩了：此后这个 transport 指向的代际已不是当前代际，任何一次投递都当场失败。
        crashDiskIOWorker(FakeWorker.instances[1]!, "died mid-replay");
        posted = transport.post(luckDraw);
        try {
          await transport.ensureLuckReceiptSecret("2026-07-19");
        } catch (error: unknown) {
          secretError = error instanceof Error ? error.message : String(error);
        }
        return false;
      }
    );
    try {
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      emitSuccessfulLoad(second);
      await Bun.sleep(0);

      expect(posted).toBeFalse();
      expect(secretError).toContain("no longer active");
      // 已死的那一代一条重放消息都不该收到；重放开始前那条提交暂缓标记发出时它仍是当前代际。
      expect(second.messages).toEqual([expect.objectContaining({ type: "load" }), { type: "storageFlushHold", active: true }]);
    } finally {
      restoreListeners();
      await fixture.dispose();
    }
  });

  test("密钥已经回来、Worker 随即死掉：这次恢复必须作废，不能用旧代际的答案继续", async () => {
    // 回执先落地、代际后翻转：Worker 的回复已经在 mailbox 里排着，它自己在下一拍崩了；
    // 这份已经到手的密钥不再用来把存储标成可写。
    const fixture: RecoveryFixture = await startDiskIO();
    let secretError: string = "";
    const restoreListeners: () => void = withOnlyRespawnListener(
      async (transport: DiskIORecoveryTransport): Promise<boolean> => {
        const second: FakeWorker = FakeWorker.instances[1]!;
        const pending: Promise<unknown> = transport.ensureLuckReceiptSecret("2026-07-19");
        // 先成功结算这次请求（waiter 就此摘掉），再让代际翻转：崩溃时的 rejectAllPendingDiskIORequests 找不到它，
        // continuation 靠自己那道代际检查发现问题。
        emitDiskIOLuckSecretReply(second, { secret: luckReceiptSecret });
        crashDiskIOWorker(second, "died after replying");
        try {
          await pending;
        } catch (error: unknown) {
          secretError = error instanceof Error ? error.message : String(error);
        }
        return true;
      }
    );
    try {
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      emitSuccessfulLoad(second);
      await Bun.sleep(0);

      expect(secretError).toContain("generation changed");
    } finally {
      restoreListeners();
      await fixture.dispose();
    }
  });

  test("取密钥失败原样抛出，整轮恢复按致命失败收口，存储保持不可写", async () => {
    const fixture: RecoveryFixture = await startDiskIO();
    const restoreListeners: () => void = withOnlyRespawnListener(
      (transport: DiskIORecoveryTransport): Promise<boolean> =>
        transport.ensureLuckReceiptSecret("2026-07-19").then((): boolean => true)
    );
    try {
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      emitSuccessfulLoad(second);
      await Bun.sleep(0);
      emitDiskIOLuckSecretReply(second, { error: "luck secret file is corrupt" });
      await Bun.sleep(0);

      expect(diskIORuntime.writable).toBeFalse();
      expect(second.terminated).toBeTrue();
      expect(fixture.fatals).toHaveLength(1);
      expect(fixture.fatals[0]?.message).toContain("mirror replay failed");
      expect(fixture.fatals[0]?.message).toContain("luck secret file is corrupt");
    } finally {
      restoreListeners();
      await fixture.dispose();
    }
  });

  test("Worker 同步拒收取密钥请求：同样按致命失败收口", async () => {
    const fixture: RecoveryFixture = await startDiskIO();
    const restoreListeners: () => void = withOnlyRespawnListener(
      (transport: DiskIORecoveryTransport): Promise<boolean> =>
        transport.ensureLuckReceiptSecret("2026-07-19").then((): boolean => true)
    );
    try {
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      second.rejectedTypes.add("ensureLuckSecret");
      emitSuccessfulLoad(second);
      await Bun.sleep(0);

      expect(diskIORuntime.writable).toBeFalse();
      expect(fixture.fatals[0]?.message).toContain("mirror replay failed");
    } finally {
      restoreListeners();
      await fixture.dispose();
    }
  });

  test("密钥正常回来时握手照常走完，存储恢复可写", async () => {
    // 前面几条是失败路径；这一条覆盖成功路径。
    const fixture: RecoveryFixture = await startDiskIO();
    let received: unknown = null;
    const restoreListeners: () => void = withOnlyRespawnListener(
      async (transport: DiskIORecoveryTransport): Promise<boolean> => {
        received = await transport.ensureLuckReceiptSecret("2026-07-19");
        return true;
      }
    );
    try {
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      emitSuccessfulLoad(second);
      await Bun.sleep(0);
      emitDiskIOLuckSecretReply(second);
      await Bun.sleep(0);

      expect(received).toEqual(luckReceiptSecret);
      expect(diskIORuntime.writable).toBeTrue();
      expect(fixture.fatals).toHaveLength(0);
    } finally {
      restoreListeners();
      await fixture.dispose();
    }
  });
});

describe("Disk I/O 恢复期的缓冲重放", () => {
  test("重放区间的开标记投不出去就停机，绝不降级为静默重放", async () => {
    // 验证开标记投递失败时区间内的写失败立即停机，不会被 postRecoveryReplayMark 静默吞掉。
    const fixture: RecoveryFixture = await startDiskIO();
    const restoreListeners: () => void = withOnlyRespawnListener((): boolean => true);
    try {
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      // 恢复握手期间到达的业务写进有硬顶的缓冲，握手走完才重放。
      diskIO.postDiskIO(luckDraw);
      expect(diskIORuntime.pendingBusinessMessages.size).toBe(1);
      second.rejectedTypes.add("recoveryReplay");
      emitSuccessfulLoad(second);
      await Bun.sleep(0);

      expect(diskIORuntime.writable).toBeFalse();
      expect(second.terminated).toBeTrue();
      expect(fixture.fatals[0]?.message).toContain("opening recovery replay mark");
    } finally {
      restoreListeners();
      await fixture.dispose();
    }
  });

  test("缓冲里的业务消息重放被拒就停机，该条留在缓冲里不销账", async () => {
    const fixture: RecoveryFixture = await startDiskIO();
    const restoreListeners: () => void = withOnlyRespawnListener((): boolean => true);
    try {
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      diskIO.postDiskIO(luckDraw);
      second.rejectedTypes.add("luckDraw");
      emitSuccessfulLoad(second);
      await Bun.sleep(0);

      expect(diskIORuntime.writable).toBeFalse();
      expect(fixture.fatals[0]?.message).toContain("rejected luckDraw during recovery replay");
      // 未确认事实保留到最终 terminate；失败本身不等于确认。
      expect(diskIORuntime.pendingBusinessMessages.size).toBe(1);
      expect(second.terminated).toBeTrue();
    } finally {
      restoreListeners();
      await fixture.dispose();
    }
  });
});

describe("Disk I/O 新代际握手与终止失败", () => {
  test("新代际连 load 请求都收不下：当场按致命失败收口，不留半初始化代际", async () => {
    const fixture: RecoveryFixture = await startDiskIO();
    try {
      // 自愈在 recoverDiskIOWorker 里同步 new Worker() 之后立刻投 load，调用方拿不到那个实例，在构造前预置。
      FakeWorker.nextRejectedTypes = ["load"];
      const second: FakeWorker = crashDiskIOWorker(fixture.first);

      expect(second.messages).toHaveLength(0);
      expect(diskIORuntime.writable).toBeFalse();
      expect(fixture.fatals[0]?.message).toContain("synchronously rejected the runtime load request");
    } finally {
      await fixture.dispose();
    }
  });

  test("恢复失败时终止旧实例本身又失败：只记诊断，不改变已经收口的结论", async () => {
    // terminate 失败不影响「存储不可写 + 已发致命信号」这个结论。
    const fixture: RecoveryFixture = await startDiskIO();
    try {
      FakeWorker.nextTerminateBehavior = "throwSync";
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      second.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret: null,
        verifications: new Map(),
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        permissionEntryCount: 0,
        error: "verification file is corrupt",
      } } as MessageEvent<DiskIOReply>);
      await Bun.sleep(0);

      expect(second.terminated).toBeTrue();
      expect(diskIORuntime.writable).toBeFalse();
      expect(fixture.fatals[0]?.message).toContain("verification file is corrupt");
      expect(fixture.consoleError.mock.calls.flat().join(" "))
        .toContain("failed to terminate unusable persistence Worker");
    } finally {
      await fixture.dispose();
    }
  });

  test("运行时恢复致命失败同样通知放弃自愈：等待方按失败结算，进程级 flush 报 failed 而非超时", async () => {
    const fixture: RecoveryFixture = await startDiskIO();
    let notified: number = 0;
    const listener = (): void => { notified++; };
    diskIO.onDiskIOGiveUp(listener);
    try {
      // 诊断批次不 ACK，进程级 flush 因此停在「等待诊断排空」。
      diskIO.relayLogMessage({ timestamp: 1, level: "error", args: ["pending"] });
      const flushing: Promise<unknown> = diskIO.flushDiskIO(60_000);
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      second.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret: null,
        verifications: new Map(),
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        permissionEntryCount: 0,
        error: "verification file is corrupt",
      } } as MessageEvent<DiskIOReply>);

      await expect(flushing).resolves.toBe("failed");
      expect(notified).toBe(1);
      expect(fixture.fatals).toHaveLength(1);
    } finally {
      diskIORuntime.giveUpListeners.splice(diskIORuntime.giveUpListeners.indexOf(listener), 1);
      await fixture.dispose();
    }
  });

  test("没有注册致命 handler 时，致命失败退回诊断出口而不是无声吞掉", async () => {
    const fixture: RecoveryFixture = await startDiskIO({ onFatal: false });
    try {
      const second: FakeWorker = crashDiskIOWorker(fixture.first);
      second.onmessage!({ data: {
        type: "loaded",
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret: null,
        verifications: new Map(),
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        permissionEntryCount: 0,
        error: "luck secret file is corrupt",
      } } as MessageEvent<DiskIOReply>);
      await Bun.sleep(0);

      expect(fixture.consoleError.mock.calls.flat().join(" "))
        .toContain("fatal persistence failure requires process restart");
    } finally {
      await fixture.dispose();
    }
  });

  test("在途 flush 撞上崩溃：一次性结算为失败并点名有多少批数据没落盘", async () => {
    const fixture: RecoveryFixture = await startDiskIO();
    try {
      const flushing: Promise<string> = diskIO.flushDiskIO(60_000);
      expect(diskIOFlushBarrier.pendingCount()).toBe(1);

      crashDiskIOWorker(fixture.first);

      expect(await flushing).toBe("failed");
      expect(diskIOFlushBarrier.pendingCount()).toBe(0);
      expect(fixture.consoleError.mock.calls.flat().join(" "))
        .toContain("1 pending flush(es) lost");
    } finally {
      await fixture.dispose();
    }
  });
});

/** 把日志批次连续打失败到触发受控重建；返回那一刻的业务 flush 请求。 */
async function driveDiagnosticRecycle(worker: FakeWorker): Promise<void> {
  diskIO.relayLogMessage({ timestamp: 1, level: "error", args: ["boom"] });
  for (
    let failure: number = 0;
    failure < DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES;
    failure++
  ) {
    const batch: Extract<DiskIOMessage, { type: "diagnosticBatch" }> =
      lastDiskIOMessage(worker, "diagnosticBatch");
    worker.onmessage!({ data: {
      type: "diagnosticBatchRetry",
      batchId: batch.batchId,
      retryAfterMs: 0,
    } } as MessageEvent<DiskIOReply>);
    await Bun.sleep(1);
  }
}

describe("Disk I/O 诊断受控重建", () => {
  test("受控重建时终止旧实例失败：只记诊断，新代际照常建起来", async () => {
    const fixture: RecoveryFixture = await startDiskIO();
    try {
      await driveDiagnosticRecycle(fixture.first);
      const flush: Extract<DiskIOMessage, { type: "flush" }> =
        lastDiskIOMessage(fixture.first, "flush");
      fixture.first.terminateBehavior = "throwSync";
      fixture.first.onmessage!({ data: {
        type: "flushed",
        flushedId: flush.flushId,
      } } as MessageEvent<DiskIOReply>);
      await Bun.sleep(0);

      expect(fixture.first.terminated).toBeTrue();
      expect(FakeWorker.instances).toHaveLength(2);
      expect(fixture.consoleError.mock.calls.flat().join(" "))
        .toContain("failed to terminate recycled persistence Worker");
    } finally {
      await fixture.dispose();
    }
  });

  test("受控重建等待期间 Worker 崩溃：回收标记归零，不挡住后续的重建", async () => {
    // 回收标记归零，之后的日志失败仍能越过 beginDiagnosticWorkerRecycle 的第一道闸，再发起受控重建。
    const fixture: RecoveryFixture = await startDiskIO();
    try {
      await driveDiagnosticRecycle(fixture.first);
      expect(diskIORuntime.diagnosticRecycleWorker).toBe(fixture.first as unknown as Worker);

      crashDiskIOWorker(fixture.first, "died awaiting business flush");

      expect(diskIORuntime.diagnosticRecycleWorker).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });
});

test("镜像已消费的 revision 覆盖旧 FIFO，镜像之后的新写仍按序重放", async (): Promise<void> => {
  const fixture: RecoveryFixture = await startDiskIO();
  const restoreListeners: () => void = withOnlyRespawnListener((transport: DiskIORecoveryTransport): boolean => {
    if (!transport.post({ type: "temporaryAdBypassWrite", id: 7, activity: null, revision: 2 })) return false;
    return diskIO.postDiskIO({ type: "temporaryAdBypassWrite", id: 7, activity: null, revision: 3 });
  });
  try {
    fixture.first.autoAcknowledgeOperations = false;
    expect(diskIO.postDiskIO({ type: "temporaryAdBypassWrite", id: 7, activity: null, revision: 1 })).toBeTrue();
    const second: FakeWorker = crashDiskIOWorker(fixture.first);
    emitSuccessfulLoad(second); await Bun.sleep(0);
    const revisions: number[] = [];
    for (const message of second.messages) if (message.type === "temporaryAdBypassWrite") revisions.push(message.revision);
    expect(revisions).toEqual([2, 3]);
    expect(diskIORuntime.writable).toBeTrue();
  } finally { restoreListeners(); await fixture.dispose(); }
});

test("贴纸镜像覆盖发送前的旧快照，发送后到达的新快照仍会落盘", async (): Promise<void> => {
  const fixture: RecoveryFixture = await startDiskIO();
  const restoreListeners: () => void = withOnlyRespawnListener((transport: DiskIORecoveryTransport): boolean => {
    if (!transport.post({ type: "stickerCatalog", revision: 1, pack: "test_pack", snapshot: "mirror" })) return false;
    return diskIO.postDiskIO({ type: "stickerCatalog", revision: 1, pack: "test_pack", snapshot: "newest" });
  });
  try {
    fixture.first.autoAcknowledgeOperations = false;
    diskIO.postDiskIO({ type: "stickerCatalog", revision: 1, pack: "test_pack", snapshot: "old" });
    const second: FakeWorker = crashDiskIOWorker(fixture.first);
    emitSuccessfulLoad(second); await Bun.sleep(0);
    const snapshots: string[] = [];
    for (const message of second.messages) if (message.type === "stickerCatalog") snapshots.push(message.snapshot);
    expect(snapshots).toEqual(["mirror", "newest"]);
    expect(diskIORuntime.writable).toBeTrue();
  } finally { restoreListeners(); await fixture.dispose(); }
});
