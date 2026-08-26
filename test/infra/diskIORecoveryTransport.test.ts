/**
 * Disk I/O 恢复握手里 scoped transport 与失败收口的各条错误路径。
 *
 * 这些分支只在「上一代 Worker 已经死了、新一代还在恢复握手中」这个窗口里到得了，
 * 生产上正是最难复现、也最不该猜的一段：镜像重放拿不到运势密钥、重放消息投不出去、
 * 新代际连 load 都收不下、终止旧实例本身又失败。走错任何一条的后果都是同一类——
 * 存储悄悄回到可写、或者反过来永久不可写，而两者都不会有第二处日志说明原因。
 *
 * 代际操纵靠 helpers/diskIOWorkerHarness.ts：`crashDiskIOWorker` 造出「正在恢复的
 * 代际」，`FakeDiskIOWorker.nextRejectedTypes` / `nextTerminateBehavior` 预置那个
 * 由宿主自己 new 出来、调用方碰不到的替身。
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
import type {
  DiskIOMessage,
  DiskIORecoveryTransport,
  DiskIOReply,
  DiskIORespawnListener,
  LuckDrawDiskMessage,
} from "../../packages/types";
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
 * 不是追加而是整表替换：生产监听器也会在同一次握手里跑，混在一起就分不清
 * 「握手停在哪一步」是本用例造成的还是别人的。
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
 * 顺带把重启节流按下：`diskIORestartThrottle` 是**模块级**滑动窗口，只允许
 * WORKER_MAX_RESTARTS 次重建，而本文件每条用例都要现造一个「正在恢复的代际」。
 * 不按住它，跑到第六条就再也建不出新代际，失败原因还会指向一个跟本用例无关的
 * 配额（同 diskIOGiveUp.test.ts 头注说明的连坐）。放弃自愈那条路由那个文件独占。
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
        // 重放刚开始，第二代就又崩了：此后这个 transport 指向的代际已经不是
        // 当前代际，任何一次投递都必须当场失败，而不是写进一个没人会读的实例。
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
      // 已死的那一代一条重放消息都不该收到。
      expect(second.messages).toEqual([{ type: "load" }]);
    } finally {
      restoreListeners();
      await fixture.dispose();
    }
  });

  test("密钥已经回来、Worker 随即死掉：这次恢复必须作废，不能用旧代际的答案继续", async () => {
    // 回执先落地、代际后翻转是真实竞态：Worker 的回复已经在 mailbox 里排着，
    // 它自己却在下一拍崩了。拿这份已经到手的密钥继续把存储标成可写，等于让
    // 一个不存在的代际替新代际做了握手。
    const fixture: RecoveryFixture = await startDiskIO();
    let secretError: string = "";
    const restoreListeners: () => void = withOnlyRespawnListener(
      async (transport: DiskIORecoveryTransport): Promise<boolean> => {
        const second: FakeWorker = FakeWorker.instances[1]!;
        const pending: Promise<unknown> = transport.ensureLuckReceiptSecret("2026-07-19");
        // 先成功结算这次请求（waiter 就此摘掉），再让代际翻转——崩溃时的
        // rejectAllPendingDiskIORequests 已经找不到它，continuation 只能靠
        // 自己那道代际检查发现问题。
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
    // 上面四条都是失败路径；这一条钉住成功那条路没有被它们连带改坏。
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
    // 漏掉开标记，区间内的写失败会退回被静默吞掉的旧行为（见 postRecoveryReplayMark）。
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
      // 收口是「整代作废 + 监督重启」，缓冲随之清空——这批事实就此声明丢失，
      // 不留给下一代去重放：那一代凭什么认为这条比别的更该补，没有任何依据。
      expect(diskIORuntime.pendingBusinessMessages.size).toBe(0);
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
      // 自愈是在 recoverDiskIOWorker 里同步 new Worker() 之后立刻投 load 的，
      // 调用方拿不到那个实例，只能在构造前预置。
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
    // terminate 失败不能反过来影响「存储不可写 + 已发致命信号」这个结论，
    // 否则一次清理故障会把真正的故障掩盖掉。
    const fixture: RecoveryFixture = await startDiskIO();
    try {
      FakeWorker.nextTerminateBehavior = "reject";
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
        whitelistEntryCount: 0,
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

  test("终止旧实例同步抛错时同样只记诊断", async () => {
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
        whitelistEntryCount: 0,
        error: "state file is corrupt",
      } } as MessageEvent<DiskIOReply>);
      await Bun.sleep(0);

      expect(diskIORuntime.writable).toBeFalse();
      expect(fixture.consoleError.mock.calls.flat().join(" "))
        .toContain("failed to terminate unusable persistence Worker");
    } finally {
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
        whitelistEntryCount: 0,
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
  test("业务 flush 以 rejection 结束：走 give-up 停机，不把 Worker 换掉了事", async () => {
    // 换掉 Worker 等于默认非日志事实已经 durable——而这一步恰恰没能确认。
    // flush barrier 当前实现只 resolve，这条 rejection 分支是给「等的这个
    // promise 不由自己撰写」留的兜底，用替身把它驱动出来。
    const fixture: RecoveryFixture = await startDiskIO();
    const begin = spyOn(diskIOFlushBarrier, "begin")
      .mockImplementation((): Promise<never> =>
        Promise.reject(new Error("flush barrier exploded")));
    const giveUps: number[] = [];
    // giveUpListeners 是模块级表，没有注销入口；本文件不能给后面的用例留一个
    // 还在往已结束用例的数组里 push 的回调。
    const savedGiveUpListeners: (() => void)[] = [...diskIORuntime.giveUpListeners];
    diskIO.onDiskIOGiveUp((): void => { giveUps.push(1); });
    try {
      await driveDiagnosticRecycle(fixture.first);
      await Bun.sleep(0);

      expect(begin).toHaveBeenCalled();
      expect(diskIORuntime.writable).toBeFalse();
      expect(giveUps).toHaveLength(1);
      expect(fixture.fatals[0]?.message).toContain("runtime persistence recovery failed");
      expect(fixture.consoleError.mock.calls.flat().join(" "))
        .toContain("diagnostic-triggered business flush rejected");
    } finally {
      diskIORuntime.giveUpListeners.splice(
        0,
        diskIORuntime.giveUpListeners.length,
        ...savedGiveUpListeners
      );
      begin.mockRestore();
      await fixture.dispose();
    }
  });

  test("受控重建时终止旧实例失败：只记诊断，新代际照常建起来", async () => {
    const fixture: RecoveryFixture = await startDiskIO();
    try {
      await driveDiagnosticRecycle(fixture.first);
      const flush: Extract<DiskIOMessage, { type: "flush" }> =
        lastDiskIOMessage(fixture.first, "flush");
      fixture.first.terminateBehavior = "reject";
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
    // 标记留着的话，之后每一次日志失败都会在 beginDiagnosticWorkerRecycle 的
    // 第一道闸被挡回去，受控重建从此再也发不起来。
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
