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
import { DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES } from
  "../../consts/diskIO/diagnostics";
import type {
  BlocklistIdPageReadReply,
  DiskIOReply,
  IdentityPoliciesReadReply,
  JoinLogReadReply,
  LoadedReply,
} from "../../types/diskIO/replies";
import type { IdentityPolicyRawReadResult } from "../../types/identityStorage";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";
import { acceptDiskIODiagnosticBatch, retryDiskIODiagnosticBatch } from
  "./diagnosticChannel";
import { settleDiskIOReply } from "./requests";
import {
  activateDiskIOWorker,
  beginDiagnosticWorkerRecycle,
  isSuccessfulLoad,
  recoverDiskIOWorker,
  stopWorkerAfterLoadFailure,
} from "./recovery";

export {
  rejectPendingDiskIORequests,
  requestBlocklistIdPageFromWorker,
  requestIdentityPoliciesFromWorker,
  requestJoinLogFromWorker,
  requestLuckSecretFromWorker,
} from "./requests";
export { clearRuntimeRecoveryTimer, stopWorkerAfterLoadFailure } from "./recovery";

/** 创建一个落盘 Worker 实例并挂上回执路由与崩溃自愈；不改变 diskIORuntime.worker。 */
export function createDiskIOWorker(): Worker {
  const w: Worker = new Worker(new URL("../../workers/diskIOWorker.ts", import.meta.url).href);
  w.unref();
  w.onmessage = (event: MessageEvent<DiskIOReply>): void => {
    if (diskIORuntime.worker !== w) return;
    const data: DiskIOReply = event.data;
    if (data.type === "diagnosticBatchAccepted") {
      if (acceptDiskIODiagnosticBatch(w, data.batchId)) {
        diskIORuntime.consecutiveDiagnosticWriteFailures = 0;
        diskIORuntime.consecutiveDiagnosticRebuilds = 0;
      }
      return;
    }
    if (data.type === "diagnosticBatchRetry") {
      const nextFailureCount: number =
        diskIORuntime.consecutiveDiagnosticWriteFailures + 1;
      const restart: boolean =
        nextFailureCount >= DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES;
      if (!retryDiskIODiagnosticBatch({
        worker: w,
        batchId: data.batchId,
        retryAfterMs: data.retryAfterMs,
        schedule: !restart,
      })) return;
      diskIORuntime.consecutiveDiagnosticWriteFailures = nextFailureCount;
      if (restart) {
        beginDiagnosticWorkerRecycle(w, nextFailureCount, createDiskIOWorker);
      }
      return;
    }
    if (data.type === "verificationPersisted") {
      for (const listener of diskIORuntime.verificationPersistedListeners) listener(data);
      return;
    }
    if (data.type === "aiMemoryDeletedPersisted") {
      for (const listener of diskIORuntime.aiMemoryDeletedPersistedListeners) listener(data);
      return;
    }
    if (data.type === "aiMemoryPersisted") {
      for (const listener of diskIORuntime.aiMemoryPersistedListeners) listener(data);
      return;
    }
    if (data.type === "recoveryReplayFailed") {
      // 这条事实对应的 update 已经被确认过了，继续跑就是静默丢数据；按
      // infra/joinLog.ts 承诺的口径停机，让 Telegram 从上一个确认点整段重投。
      stopWorkerAfterLoadFailure(
        w,
        `${data.domain} replay failed during recovery: ${data.error}`,
        true
      );
      return;
    }
    if (data.type === "luckAppendStalled") {
      // 本文件自身的错误照旧只走非递归诊断 sink；这一条是 Worker 报上来的**领域数据
      // 丢失**事实，转交运势 owner 记进统一 logs/，理由见 types/diskIO.ts 的
      // LuckAppendStalledReply。
      for (const listener of diskIORuntime.luckAppendStalledListeners) listener(data);
      return;
    }
    if (data.type === "identityStoragePersisted") {
      for (const listener of diskIORuntime.identityStoragePersistedListeners) listener(data);
      return;
    }
    if (data.type === "flushed" || data.type === "flushFailed") {
      // 失败领域名要落进非递归诊断——Worker 侧的写盘错误按设计只有 console.error，
      // 不带领域名的话运维根本看不出是哪个文件坏了。按领域的**判定**只走下面
      // 那张按 flushId 记账的表：进程级的「最后一次回执」会让某次超时的 flush
      // 报出另一次 flush 的失败领域。
      if (data.type === "flushFailed") {
        writeDiskIODiagnostic(`[diskIO] flush failed for domain(s): ${data.failedDomains.join(", ")}.`);
      }
      const settled: boolean = diskIOFlushBarrier.settle(
        data.flushedId,
        data.type === "flushed" ? "flushed" : "failed"
      );
      if (settled && data.type === "flushFailed") {
        pendingFlushFailedDomains.set(data.flushedId, data.failedDomains);
      }
      return;
    }
    if (data.type === "luckSecret") {
      settleDiskIOReply({
        channel: luckSecretRequests,
        requestId: data.requestId,
        error: data.error,
        payload: data.secret,
      });
      return;
    }
    if (data.type === "joinLogRead") {
      const reply: JoinLogReadReply = data;
      settleDiskIOReply({
        channel: joinLogReadRequests,
        requestId: reply.requestId,
        error: reply.error,
        payload: reply.records,
      });
      return;
    }
    if (data.type === "identityPoliciesRead") {
      const reply: IdentityPoliciesReadReply = data;
      // 两张表缺任意一张都不算有效载荷；合成对象只在都在时构造。
      const rows: IdentityPolicyRawReadResult | undefined =
        reply.whitelist === undefined || reply.blocklist === undefined
          ? undefined
          : { whitelist: reply.whitelist, blocklist: reply.blocklist };
      settleDiskIOReply({
        channel: identityPolicyReadRequests,
        requestId: reply.requestId,
        error: reply.error,
        payload: rows,
      });
      return;
    }
    if (data.type === "blocklistIdPageRead") {
      const reply: BlocklistIdPageReadReply = data;
      settleDiskIOReply({
        channel: blocklistIdPageReadRequests,
        requestId: reply.requestId,
        error: reply.error,
        payload: reply.page,
      });
      return;
    }
    // data.type === "loaded"：启动和运行时重建都必须先验证完整恢复结果，
    // 任何领域失败时都不能进入 writable，也不能重放可能覆盖旧数据的镜像。
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
