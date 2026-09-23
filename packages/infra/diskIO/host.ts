/** Disk I/O Worker 工厂与回执路由；请求通道和恢复状态机位于同目录叶子模块。 */

import {
  blocklistIdPageReadRequests,
  diskIOFlushBarrier,
  diskIORuntime,
  identityPolicyReadRequests,
  joinLogReadRequests,
  luckSecretRequests,
  pendingFlushFailedDomains,
  pendingLoad,
} from "../../cache/main/diskIO";
import { DISK_IO_WORKER_URL } from "../../consts/paths";
import { DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES } from
  "../../consts/diskIO/diagnostics";
import type {
  DiskIOReply,
  DiskIOReplyListenerMap,
  LoadedReply,
} from "../../types/diskIO/replies";
import type { IdentityPolicyRawReadResult } from "../../types/identityStorage";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";
import { acceptDiskIODiagnosticBatch, retryDiskIODiagnosticBatch } from
  "./diagnosticChannel";
import { settleDiskIOReply } from "./requests";
import { acceptDiskIOOperationBatch } from "./transport";
import { signalDiskIOFatal } from "./fatal";
import {
  activateDiskIOWorker,
  beginDiagnosticWorkerRecycle,
  isSuccessfulLoad,
  recoverDiskIOWorker,
  stopWorkerAfterLoadFailure,
} from "./recovery";

/** 把一条可订阅回执交给登记在该类型下的全部主线程 owner。 */
function notifyReplyListeners<K extends keyof DiskIOReplyListenerMap>(
  type: K,
  reply: DiskIOReplyListenerMap[K]
): void {
  for (const listener of diskIORuntime.replyListeners[type]) listener(reply);
}

/**
 * 恢复握手的 loaded 回执：启动和运行时重建都必须先验证完整恢复结果，任何领域失败
 * 时都不能进入 writable，也不能重放可能覆盖旧数据的镜像。
 */
function handleLoadedReply(w: Worker, data: LoadedReply): void {
  const resolve: ((reply: LoadedReply) => void) | null = pendingLoad.resolve;
  if (resolve) {
    pendingLoad.resolve = null;
    pendingLoad.reject = null;
    if (pendingLoad.timer !== null) clearTimeout(pendingLoad.timer);
    pendingLoad.timer = null;
    resolve(data);
    if (isSuccessfulLoad(data)) void activateDiskIOWorker(w, false);
    else stopWorkerAfterLoadFailure(w, data.error ?? "no luck receipt secret returned", false);
    return;
  }
  if (diskIORuntime.runtimeRecoveryWorker !== w) return;
  if (!isSuccessfulLoad(data)) {
    stopWorkerAfterLoadFailure(w, data.error ?? "no luck receipt secret returned", true);
    return;
  }
  void activateDiskIOWorker(w, true);
}

/** 诊断批次写失败：按连续失败数决定重排还是回收整个 Worker。 */
function handleDiagnosticBatchRetry(w: Worker, batchId: number, retryAfterMs: number): void {
  const nextFailureCount: number =
    diskIORuntime.consecutiveDiagnosticWriteFailures + 1;
  const restart: boolean =
    nextFailureCount >= DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES;
  if (!retryDiskIODiagnosticBatch({
    worker: w,
    batchId,
    retryAfterMs,
    schedule: !restart,
  })) return;
  diskIORuntime.consecutiveDiagnosticWriteFailures = nextFailureCount;
  if (restart) {
    beginDiagnosticWorkerRecycle(w, nextFailureCount, createDiskIOWorker);
  }
}

/**
 * 创建一个落盘 Worker 实例并挂上回执路由与崩溃自愈；不改变 diskIORuntime.worker。
 * 运势追加停摆（luckAppendStalled）是 Worker 报上来的领域数据丢失事实，与其它可订阅
 * 回执一样转交 owner 记进统一 logs/；本文件自身的错误只走非递归诊断 sink（见
 * types/diskIO/replies.ts 的 LuckAppendStalledReply）。
 */
export function createDiskIOWorker(): Worker {
  const w: Worker = new Worker(DISK_IO_WORKER_URL);
  w.unref();
  w.onmessage = (event: MessageEvent<DiskIOReply>): void => {
    if (diskIORuntime.worker !== w) return;
    const data: DiskIOReply = event.data;
    switch (data.type) {
      case "midnightMaintenance":
      case "verificationPersisted":
      case "aiMemoryDeletedPersisted":
      case "wedMembersDeletedPersisted":
      case "aiMemoryPersisted":
      case "stickerCatalogPersisted":
      case "luckAppendStalled":
      case "identityStoragePersisted":
        notifyReplyListeners(data.type, data);
        return;
      case "operationBatchAccepted":
        acceptDiskIOOperationBatch(w, data.batchId);
        return;
      case "storageWriteStalled":
        signalDiskIOFatal(new Error("Storage database writes stalled; refusing new business writes."));
        return;
      case "diagnosticBatchAccepted":
        if (acceptDiskIODiagnosticBatch(w, data.batchId)) {
          diskIORuntime.consecutiveDiagnosticWriteFailures = 0;
          diskIORuntime.consecutiveDiagnosticRebuilds = 0;
        }
        return;
      case "diagnosticBatchRetry":
        handleDiagnosticBatchRetry(w, data.batchId, data.retryAfterMs);
        return;
      case "recoveryReplayFailed":
        // 对应的 update 已被确认过；按 infra/joinLog.ts 的口径停机，
        // 让 Telegram 从上一个确认点重投。
        stopWorkerAfterLoadFailure(
          w,
          `${data.domain} replay failed during recovery: ${data.error}`,
          true
        );
        return;
      case "flushed":
        diskIOFlushBarrier.settle(data.flushedId, "flushed");
        return;
      case "flushFailed":
        // 失败领域名落入非递归诊断，Worker 侧写盘错误按设计只有 console.error。
        // 按领域的判定只读下面按 flushId 记账的表，不使用进程级的「最后一次回执」。
        writeDiskIODiagnostic(`[diskIO] flush failed for domain(s): ${data.failedDomains.join(", ")}.`);
        if (diskIOFlushBarrier.settle(data.flushedId, "failed")) {
          pendingFlushFailedDomains.set(data.flushedId, data.failedDomains);
        }
        return;
      case "luckSecret":
        settleDiskIOReply({
          channel: luckSecretRequests,
          requestId: data.requestId,
          error: data.error,
          payload: data.secret,
        });
        return;
      case "joinLogRead":
        settleDiskIOReply({
          channel: joinLogReadRequests,
          requestId: data.requestId,
          error: data.error,
          payload: data.records,
        });
        return;
      case "identityPoliciesRead":
        settleDiskIOReply({
          channel: identityPolicyReadRequests,
          requestId: data.requestId,
          error: data.error,
          // 三张表缺任意一张都不算有效载荷；合成对象只在都在时构造。
          payload: data.whitelist === undefined ||
            data.blocklist === undefined ||
            data.temporaryAdBypass === undefined
            ? undefined
            : {
              whitelist: data.whitelist,
              blocklist: data.blocklist,
              temporaryAdBypass: data.temporaryAdBypass,
            } satisfies IdentityPolicyRawReadResult,
        });
        return;
      case "blocklistIdPageRead":
        settleDiskIOReply({
          channel: blocklistIdPageReadRequests,
          requestId: data.requestId,
          error: data.error,
          payload: data.page,
        });
        return;
      case "loaded":
        handleLoadedReply(w, data);
    }
  };
  w.onerror = (event: ErrorEvent): void => {
    // Bun 在未捕获异常后已经终止 Worker；这里只复用代际失效与恢复协议，不能再次
    // terminate。旧实例的迟到/重复错误由 recoverDiskIOWorker 的代际 guard 拒绝。
    recoverDiskIOWorker({
      createWorker: createDiskIOWorker,
      worker: w,
      reason: event.message || String(event.error || event),
      terminateWorker: false,
      cause:
        diskIORuntime.diagnosticRecycleWorker === w
          ? "diagnostic"
          : "crash",
    });
  };
  return w;
}
