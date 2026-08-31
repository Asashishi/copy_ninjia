/** Disk I/O Worker 的恢复握手、镜像重放、重启节流与诊断受控重建。 */

import {
  diskIOFlushBarrier,
  diskIORestartThrottle,
  diskIORuntime,
  pendingFlushFailedDomains,
} from "../../cache/main/diskIO";
import {
  DISK_DIAGNOSTIC_FATAL_REBUILD_THRESHOLD,
} from "../../consts/diskIO/diagnostics";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from
  "../../consts/workerSupervisor";
import type {
  DiskBusinessMessage,
  DiskFlushRequest,
  DiskIORecoveryTransport,
  LoadRequest,
  RecoveryReplayRequest,
} from "../../types/diskIO/messages";
import type { LoadedReply } from "../../types/diskIO/replies";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import type { FlushResult } from "../../types/lifecycle";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";
import { getStickerConfig } from "../../config/stickers";
import { pauseDiskIODiagnosticChannel, resumeDiskIODiagnosticChannel } from
  "./diagnosticChannel";
import {
  rejectAllPendingDiskIORequests,
  requestLuckSecretFromWorker,
} from "./requests";
import { safePostDiskIO } from "./transport";

/** 清除运行时恢复握手的超时 timer；重复调用安全。 */
export function clearRuntimeRecoveryTimer(): void {
  if (diskIORuntime.runtimeRecoveryTimer === null) return;
  clearTimeout(diskIORuntime.runtimeRecoveryTimer);
  diskIORuntime.runtimeRecoveryTimer = null;
}

function signalDiskIOFatal(error: Error): void {
  if (diskIORuntime.fatalSignaled) return;
  diskIORuntime.fatalSignaled = true;
  if (diskIORuntime.fatalHandler !== undefined) {
    diskIORuntime.fatalHandler(error);
  } else {
    writeDiskIODiagnostic("[diskIO] fatal persistence failure requires process restart:", error.message);
  }
}

/**
 * 恢复失败的统一收口：让存储保持不可写、结算所有等待方并终止该实例。
 * @param fatal 是否升级为需要进程重启的致命失败（运行时恢复路径为 true）。
 */
export function stopWorkerAfterLoadFailure(worker: Worker, reason: string, fatal: boolean): void {
  if (diskIORuntime.worker !== worker) return;
  clearRuntimeRecoveryTimer();
  writeDiskIODiagnostic(
    `[diskIO] persistence recovery failed; keeping storage unavailable and refusing writes: ${reason}`
  );
  diskIORuntime.worker = null;
  diskIORuntime.runtimeRecoveryWorker = null;
  diskIORuntime.writable = false;
  pauseDiskIODiagnosticChannel();
  diskIORuntime.pendingBusinessMessages.clear();
  diskIOFlushBarrier.settleAll("failed");
  rejectAllPendingDiskIORequests((): string =>
    `Persistence Worker became unavailable during recovery: ${reason}`);
  try {
    void Promise.resolve(worker.terminate()).catch((error: unknown): void => {
      writeDiskIODiagnostic("[diskIO] failed to terminate unusable persistence Worker:", error);
    });
  } catch (error: unknown) {
    writeDiskIODiagnostic("[diskIO] failed to terminate unusable persistence Worker:", error);
  }
  if (fatal) signalDiskIOFatal(new Error(`[diskIO] runtime persistence recovery failed: ${reason}`));
}

export function isSuccessfulLoad(reply: LoadedReply): boolean {
  return reply.error === undefined && reply.luckReceiptSecret !== null;
}

function isCurrentRecoveryWorker(worker: Worker): boolean {
  return diskIORuntime.worker === worker &&
    diskIORuntime.runtimeRecoveryWorker === worker &&
    !diskIORuntime.writable;
}

interface RecoveryTransportScope {
  transport: DiskIORecoveryTransport;
  deactivate(): void;
  failed(): boolean;
}

function createRecoveryTransportScope(worker: Worker): RecoveryTransportScope {
  let active: boolean = true;
  let transportFailed: boolean = false;
  const isUsable = (): boolean => active && isCurrentRecoveryWorker(worker);
  const transport: DiskIORecoveryTransport = {
    post: (message: DiskBusinessMessage): boolean => {
      if (!isUsable()) {
        transportFailed = true;
        return false;
      }
      const posted: boolean = safePostDiskIO(
        worker,
        message,
        `recovery replay ${message.type}`
      );
      if (!posted) transportFailed = true;
      return posted;
    },
    ensureLuckReceiptSecret: async (day: string): Promise<LuckReceiptSecret> => {
      if (!isUsable()) {
        transportFailed = true;
        throw new Error("Disk I/O recovery transport is no longer active.");
      }
      try {
        const secret: LuckReceiptSecret = await requestLuckSecretFromWorker({
          worker,
          day,
          timeoutMs: diskIORuntime.runtimeRecoveryTimeoutMs,
          context: "recovery luck receipt secret request",
        });
        if (!isUsable()) {
          transportFailed = true;
          throw new Error("Disk I/O recovery generation changed while loading the luck secret.");
        }
        return secret;
      } catch (error: unknown) {
        transportFailed = true;
        throw error;
      }
    },
  };
  return {
    transport,
    deactivate: (): void => { active = false; },
    failed: (): boolean => transportFailed,
  };
}

function describeRecoveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 开合重放区间标记。投递失败按 fatal 处理：开标记确保区间内写失败升级为停机，
 * 关标记确保恢复完成后的在线写回到常规失败语义。
 */
function postRecoveryReplayMark(worker: Worker, active: boolean): boolean {
  const request: RecoveryReplayRequest = { type: "recoveryReplay", active };
  if (safePostDiskIO(worker, request, `recovery replay mark (${active ? "open" : "close"})`)) return true;
  stopWorkerAfterLoadFailure(
    worker,
    `Worker rejected the ${active ? "opening" : "closing"} recovery replay mark`,
    true
  );
  return false;
}

export async function activateDiskIOWorker(worker: Worker, replayMirrors: boolean): Promise<void> {
  if (diskIORuntime.worker !== worker) return;
  if (replayMirrors) {
    // 按显式优先级等待各领域镜像；整个握手保持不可写，恢复 timer 继续覆盖
    // 异步 listener，普通业务增量则留在有硬顶的 FIFO 缓冲里。
    for (const registration of diskIORuntime.respawnListeners) {
      const scope: RecoveryTransportScope = createRecoveryTransportScope(worker);
      let replayed: boolean;
      try {
        replayed = await registration.listener(scope.transport);
      } catch (error: unknown) {
        scope.deactivate();
        if (!isCurrentRecoveryWorker(worker)) return;
        stopWorkerAfterLoadFailure(
          worker,
          `${registration.owner} mirror replay failed: ${describeRecoveryError(error)}`,
          true
        );
        return;
      }
      scope.deactivate();
      if (!isCurrentRecoveryWorker(worker)) return;
      if (!replayed || scope.failed()) {
        stopWorkerAfterLoadFailure(
          worker,
          `${registration.owner} mirror replay reported failure`,
          true
        );
        return;
      }
    }
  }
  // 重放区间要圈起来告诉 Worker：区间内的写失败没有任何后续 flush 会去问，
  // 只能按 fatal 停机处理（见 types/diskIO.ts 的 RecoveryReplayRequest）。整段
  // 排空是同步的，中间不会插进在线消息，因此这对标记框住的恰好是重放的那一批。
  if (diskIORuntime.pendingBusinessMessages.size > 0) {
    if (!postRecoveryReplayMark(worker, true)) return;
    while (diskIORuntime.pendingBusinessMessages.size > 0) {
      if (replayMirrors && !isCurrentRecoveryWorker(worker)) return;
      if (!replayMirrors && diskIORuntime.worker !== worker) return;
      const message: DiskBusinessMessage = diskIORuntime.pendingBusinessMessages.peek()!;
      if (!safePostDiskIO(worker, message, `replay ${message.type}`)) {
        stopWorkerAfterLoadFailure(worker, `Worker rejected ${message.type} during recovery replay`, true);
        return;
      }
      diskIORuntime.pendingBusinessMessages.shift();
    }
    if (!postRecoveryReplayMark(worker, false)) return;
  }
  if (replayMirrors && !isCurrentRecoveryWorker(worker)) return;
  if (!replayMirrors && diskIORuntime.worker !== worker) return;
  clearRuntimeRecoveryTimer();
  diskIORuntime.runtimeRecoveryWorker = null;
  diskIORuntime.writable = true;
  resumeDiskIODiagnosticChannel(worker);
}

function beginRuntimeRecovery(worker: Worker): void {
  clearRuntimeRecoveryTimer();
  diskIORuntime.runtimeRecoveryWorker = worker;
  diskIORuntime.runtimeRecoveryTimer = setTimeout((): void => {
    diskIORuntime.runtimeRecoveryTimer = null;
    stopWorkerAfterLoadFailure(
      worker,
      `runtime load handshake timed out after ${diskIORuntime.runtimeRecoveryTimeoutMs}ms`,
      true
    );
  }, diskIORuntime.runtimeRecoveryTimeoutMs);
  diskIORuntime.runtimeRecoveryTimer.unref();
  const request: LoadRequest = {
    type: "load",
    stickerPacks: getStickerConfig().packs,
  };
  if (!safePostDiskIO(worker, request, "runtime load request")) {
    stopWorkerAfterLoadFailure(worker, "Worker synchronously rejected the runtime load request", true);
  }
}

interface RecoverDiskIOWorkerOptions {
  readonly createWorker: () => Worker;
  worker: Worker;
  reason: string;
  terminateWorker: boolean;
  cause: "crash" | "diagnostic";
}

/**
 * 当前 DiskIO 代际失效后的唯一恢复入口。未捕获异常与诊断连续写盘失败共用同一套
 * 等待者结算、重启节流、load 握手和镜像重放，避免两条恢复链并行改写宿主状态。
 */
export function recoverDiskIOWorker({
  createWorker,
  worker,
  reason,
  terminateWorker,
  cause,
}: RecoverDiskIOWorkerOptions): void {
  if (diskIORuntime.worker !== worker) return;
  if (terminateWorker) {
    writeDiskIODiagnostic(`[diskIO] recycling persistence Worker after ${reason}.`);
  } else {
    writeDiskIODiagnostic("[diskIO] persistence Worker errored:", reason);
  }
  diskIORuntime.worker = null;
  diskIORuntime.writable = false;
  if (diskIORuntime.diagnosticRecycleWorker === worker) {
    diskIORuntime.diagnosticRecycleWorker = null;
  }
  pauseDiskIODiagnosticChannel();
  if (diskIORuntime.runtimeRecoveryWorker === worker) {
    diskIORuntime.runtimeRecoveryWorker = null;
    clearRuntimeRecoveryTimer();
  }
  const pendingFlushCount: number = diskIOFlushBarrier.pendingCount();
  if (pendingFlushCount > 0) {
    writeDiskIODiagnostic(
      `[diskIO] ${pendingFlushCount} pending flush(es) lost — persistence Worker became unavailable mid-flush, ` +
      "their buffered data was not written to disk."
    );
    diskIOFlushBarrier.settleAll("failed");
  }
  rejectAllPendingDiskIORequests((label: string): string =>
    `Persistence Worker became unavailable while awaiting the ${label} reply.`);
  if (terminateWorker) {
    try {
      void Promise.resolve(worker.terminate()).catch((error: unknown): void => {
        writeDiskIODiagnostic("[diskIO] failed to terminate recycled persistence Worker:", error);
      });
    } catch (error: unknown) {
      writeDiskIODiagnostic("[diskIO] failed to terminate recycled persistence Worker:", error);
    }
  }
  const diagnosticRebuilds: number = cause === "diagnostic"
    ? diskIORuntime.consecutiveDiagnosticRebuilds + 1
    : diskIORuntime.consecutiveDiagnosticRebuilds;
  const diagnosticGiveUp: boolean = cause === "diagnostic" &&
    diagnosticRebuilds >= DISK_DIAGNOSTIC_FATAL_REBUILD_THRESHOLD;
  const crashGiveUp: boolean = cause === "crash" &&
    diskIORestartThrottle.shouldGiveUp();
  if (diagnosticGiveUp || crashGiveUp) {
    writeDiskIODiagnostic(
      diagnosticGiveUp
        ? `[diskIO] diagnostic log persistence required ${diagnosticRebuilds} consecutive Worker rebuilds, ` +
          "giving up self-healing and forcing a supervised process restart before any more updates are accepted."
        : `[diskIO] persistence Worker restarted ${WORKER_MAX_RESTARTS} times within ` +
          `${WORKER_RESTART_WINDOW_MS / 1000}s, giving up self-healing and forcing a supervised process restart ` +
          "before any more updates are accepted."
    );
    diskIORuntime.pendingBusinessMessages.clear();
    for (const listener of diskIORuntime.giveUpListeners) listener();
    signalDiskIOFatal(new Error("Persistence Worker exhausted its runtime restart budget."));
    return;
  }
  if (cause === "diagnostic") {
    diskIORuntime.consecutiveDiagnosticRebuilds = diagnosticRebuilds;
  }
  diskIORuntime.consecutiveDiagnosticWriteFailures = 0;
  const next: Worker = createWorker();
  diskIORuntime.worker = next;
  beginRuntimeRecovery(next);
}

/**
 * 诊断故障触发受控重建前只刷业务领域；失败的日志批次仍由主线程 ACK 队列持有，
 * 不能让通用 flush 先等待它而永远走不到业务刷盘。
 */
async function flushBusinessBeforeDiagnosticRecycle(
  worker: Worker
): Promise<FlushResult> {
  let flushId: number | null = null;
  const result: FlushResult = await diskIOFlushBarrier.begin(
    (id: number): boolean => {
      flushId = id;
      const request: DiskFlushRequest = {
        type: "flush",
        flushId: id,
        scope: "business",
      };
      return safePostDiskIO(worker, request, "diagnostic recycle business flush");
    },
    DISK_IO_FLUSH_TIMEOUT_MS
  );
  if (flushId !== null) pendingFlushFailedDomains.delete(flushId);
  return result;
}

/** 日志连续失败达到阈值后先封住业务入口并确保非日志事实 durable，再替换 Worker。 */
export function beginDiagnosticWorkerRecycle(
  worker: Worker,
  failureCount: number,
  createWorker: () => Worker
): void {
  if (
    diskIORuntime.worker !== worker ||
    !diskIORuntime.writable ||
    diskIORuntime.diagnosticRecycleWorker !== null
  ) return;
  diskIORuntime.writable = false;
  diskIORuntime.diagnosticRecycleWorker = worker;
  pauseDiskIODiagnosticChannel();
  void flushBusinessBeforeDiagnosticRecycle(worker).then(
    (result: FlushResult): void => {
      if (
        diskIORuntime.worker !== worker ||
        diskIORuntime.diagnosticRecycleWorker !== worker
      ) return;
      diskIORuntime.diagnosticRecycleWorker = null;
      if (result !== "flushed") {
        writeDiskIODiagnostic(
          `[diskIO] refusing diagnostic-triggered Worker recycle because the business flush ${result}; ` +
          "forcing a supervised process restart without guessing whether non-log facts are durable."
        );
        for (const listener of diskIORuntime.giveUpListeners) listener();
        stopWorkerAfterLoadFailure(
          worker,
          `business flush ${result} before diagnostic-triggered recycle`,
          true
        );
        return;
      }
      recoverDiskIOWorker({
        createWorker,
        worker,
        reason:
          `diagnostic log persistence failed ${failureCount} consecutive times`,
        terminateWorker: true,
        cause: "diagnostic",
      });
    },
    (error: unknown): void => {
      if (
        diskIORuntime.worker !== worker ||
        diskIORuntime.diagnosticRecycleWorker !== worker
      ) return;
      diskIORuntime.diagnosticRecycleWorker = null;
      writeDiskIODiagnostic(
        "[diskIO] diagnostic-triggered business flush rejected; forcing a supervised process restart:",
        error
      );
      for (const listener of diskIORuntime.giveUpListeners) listener();
      stopWorkerAfterLoadFailure(
        worker,
        "business flush rejected before diagnostic-triggered recycle",
        true
      );
    }
  );
}
