import {
  DISK_IO_REQUEST_CHANNELS,
  blocklistIdReadRequests,
  diskIOFlushBarrier,
  diskIORestartThrottle,
  diskIORuntime,
  identityPolicyReadRequests,
  joinLogReadRequests,
  luckSecretRequests,
  pendingFlushFailedDomains,
  pendingLoad,
} from "../../cache/main/diskIO";
import type {
  DiskIORequestChannel,
  PendingDiskIORequest,
} from "../../cache/main/diskIO";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../../consts/workerSupervisor";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import {
  DISK_DIAGNOSTIC_FATAL_REBUILD_THRESHOLD,
  DISK_DIAGNOSTIC_MAX_CONSECUTIVE_WRITE_FAILURES,
} from "../../consts/diskIO/diagnostics";
import type {
  DiskBusinessMessage,
  DiskFlushRequest,
  DiskIOReply,
  DiskIORecoveryTransport,
  DiskIORequestMessage,
  EnsureLuckSecretRequest,
  JoinLogReadReply,
  IdentityPoliciesReadReply,
  BlocklistIdsReadReply,
  LoadRequest,
  LoadedReply,
  ReadJoinLogRequest,
  ReadIdentityPoliciesRequest,
  ReadBlocklistIdsRequest,
  RecoveryReplayRequest,
} from "../../types/diskIO";
import type { FlushResult } from "../../types/lifecycle";
import type { JoinLogRecord, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { IdentityPolicyRawReadResult } from "../../types/identityStorage";
import { writeDiskIODiagnostic } from "../../workers/diskIO/diagnosticSink";
import {
  acceptDiskIODiagnosticBatch,
  pauseDiskIODiagnosticChannel,
  resumeDiskIODiagnosticChannel,
  retryDiskIODiagnosticBatch,
} from "./diagnosticChannel";
import { safePostDiskIO } from "./transport";

/**
 * Disk I/O Worker 的宿主内核（owner 是 packages/infra/diskIO.ts）：Worker 创建、
 * onmessage 回执路由、onerror 崩溃自愈与运行时恢复握手。主文件保留
 * init/post/flush/terminate 与启动握手这一层对外语义。
 *
 * 本文件的错误一律走 workers/diskIO/diagnosticSink.ts 的非递归出口，不能
 * 指望被自己转发的日志线程落盘自己的错误，否则是一场递归。这也是 Disk I/O 不复用
 * infra/supervisedWorker.ts 通用骨架（其 onerror 走 logger.error）的原因。
 * @see ../../../docs/cn/04-invariants.md
 */

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

/** 结算一条通道上的全部等待者；Worker 代际失效与 terminate 共用。 */
export function rejectPendingDiskIORequests<TResult>(
  channel: DiskIORequestChannel<TResult>,
  error: Error
): void {
  for (const pending of channel.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  channel.pending.clear();
}

/** 一次结算全部通道；漏掉任何一类等待者都会让调用方干等到自己的超时。 */
function rejectAllPendingDiskIORequests(describe: (label: string) => string): void {
  for (const channel of DISK_IO_REQUEST_CHANNELS) {
    rejectPendingDiskIORequests(channel, new Error(describe(channel.label)));
  }
}

interface RequestDiskIOParams<TResult, TRequest extends DiskIORequestMessage> {
  worker: Worker;
  channel: DiskIORequestChannel<TResult>;
  timeoutMs: number;
  /** 用通道发出的 requestId 组装信封；调用方不自行编号。 */
  buildRequest: (requestId: number) => TRequest;
  /** 覆盖文案里的领域名；恢复握手用它区分「恢复期的那一次请求」。 */
  context?: string;
}

/**
 * main -> diskIO 的统一 request/reply 发起点：发号、登记等待者、装超时、投递，
 * 同步拒收时立刻结算。四个领域此前各自抄了一份这二十来行，超时与拒收文案、
 * 以及「拒收后要把等待者摘掉」这一步都得逐份维护。
 */
function requestDiskIO<TResult, TRequest extends DiskIORequestMessage>({
  worker,
  channel,
  timeoutMs,
  buildRequest,
  context,
}: RequestDiskIOParams<TResult, TRequest>): Promise<TResult> {
  const label: string = context ?? channel.label;
  const requestId: number = channel.nextRequestId++;
  return new Promise((
    resolve: (value: TResult | PromiseLike<TResult>) => void,
    reject: (reason?: unknown) => void
  ): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      channel.pending.delete(requestId);
      reject(new Error(`[diskIO] ${label} request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    channel.pending.set(requestId, { resolve, reject, timer });
    if (safePostDiskIO(worker, buildRequest(requestId), `${label} request`)) return;
    channel.pending.delete(requestId);
    clearTimeout(timer);
    reject(new Error(`[diskIO] persistence Worker rejected the ${label} request.`));
  });
}

interface SettleDiskIOReplyParams<TResult> {
  channel: DiskIORequestChannel<TResult>;
  requestId: number;
  /** Worker 明确报出的领域错误；缺席才看载荷。 */
  error: string | undefined;
  /** 已经收窄成本通道结果类型的载荷；缺席按失败结算。 */
  payload: TResult | undefined;
}

/**
 * 用一条回执结算对应等待者。迟到、重复或已超时的 requestId 一律忽略；
 * Worker 明确报错或没带载荷时按失败结算，绝不把「没读到」解释成空结果。
 */
function settleDiskIOReply<TResult>({
  channel,
  requestId,
  error,
  payload,
}: SettleDiskIOReplyParams<TResult>): void {
  const pending: PendingDiskIORequest<TResult> | undefined = channel.pending.get(requestId);
  if (pending === undefined) return;
  channel.pending.delete(requestId);
  clearTimeout(pending.timer);
  if (error !== undefined || payload === undefined) {
    pending.reject(new Error(error ?? channel.missingPayload));
    return;
  }
  pending.resolve(payload);
}

/**
 * 向指定代际请求运势密钥。公开入口与恢复 scoped transport 共用同一套 waiter
 * 记账，Worker 崩溃或恢复失败时由宿主统一拒绝。
 */
export interface RequestLuckSecretParams {
  worker: Worker;
  day: string;
  timeoutMs: number;
  context: string;
}

export function requestLuckSecretFromWorker({
  worker,
  day,
  timeoutMs,
  context,
}: RequestLuckSecretParams): Promise<LuckReceiptSecret> {
  return requestDiskIO<LuckReceiptSecret, EnsureLuckSecretRequest>({
    worker,
    channel: luckSecretRequests,
    timeoutMs,
    context,
    buildRequest: (requestId: number): EnsureLuckSecretRequest => ({
      type: "ensureLuckSecret",
      requestId,
      day,
    }),
  });
}

/** 向当前可写代际按需读取本群滚动时间窗内的入群日志。 */
export interface RequestJoinLogParams {
  worker: Worker;
  chatId: number;
  since: number;
  now: number;
  timeoutMs: number;
}

export function requestJoinLogFromWorker({
  worker,
  chatId,
  since,
  now,
  timeoutMs,
}: RequestJoinLogParams): Promise<readonly JoinLogRecord[]> {
  return requestDiskIO<readonly JoinLogRecord[], ReadJoinLogRequest>({
    worker,
    channel: joinLogReadRequests,
    timeoutMs,
    buildRequest: (requestId: number): ReadJoinLogRequest => ({
      type: "readJoinLog",
      requestId,
      chatId,
      since,
      now,
    }),
  });
}

/** 向当前 Disk I/O 代际批量读取两个身份策略表。 */
export interface RequestIdentityPoliciesParams {
  worker: Worker;
  ids: readonly number[];
  timeoutMs: number;
}

export function requestIdentityPoliciesFromWorker({
  worker,
  ids,
  timeoutMs,
}: RequestIdentityPoliciesParams): Promise<IdentityPolicyRawReadResult> {
  return requestDiskIO<IdentityPolicyRawReadResult, ReadIdentityPoliciesRequest>({
    worker,
    channel: identityPolicyReadRequests,
    timeoutMs,
    buildRequest: (requestId: number): ReadIdentityPoliciesRequest => ({
      type: "readIdentityPolicies",
      requestId,
      ids,
    }),
  });
}

/** 向当前 Disk I/O 代际读取完整黑名单主键集合。 */
export function requestBlocklistIdsFromWorker(
  worker: Worker,
  timeoutMs: number
): Promise<readonly number[]> {
  return requestDiskIO<readonly number[], ReadBlocklistIdsRequest>({
    worker,
    channel: blocklistIdReadRequests,
    timeoutMs,
    buildRequest: (requestId: number): ReadBlocklistIdsRequest => ({
      type: "readBlocklistIds",
      requestId,
    }),
  });
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

function isSuccessfulLoad(reply: LoadedReply): boolean {
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
 * 开合重放区间标记。投递失败按 fatal 处理而不是降级继续：漏掉开标记会让区间内
 * 的写失败退回被静默吞掉的旧行为，漏掉关标记则会把之后每一次在线写失败都误升级
 * 成停机——两个方向都不能默默容忍。
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

async function activateDiskIOWorker(worker: Worker, replayMirrors: boolean): Promise<void> {
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
  if (!safePostDiskIO(worker, { type: "load" } satisfies LoadRequest, "runtime load request")) {
    stopWorkerAfterLoadFailure(worker, "Worker synchronously rejected the runtime load request", true);
  }
}

interface RecoverDiskIOWorkerOptions {
  worker: Worker;
  reason: string;
  terminateWorker: boolean;
  cause: "crash" | "diagnostic";
}

/**
 * 当前 DiskIO 代际失效后的唯一恢复入口。未捕获异常与诊断连续写盘失败共用同一套
 * 等待者结算、重启节流、load 握手和镜像重放，避免两条恢复链并行改写宿主状态。
 */
function recoverDiskIOWorker({
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
  const next: Worker = createDiskIOWorker();
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
function beginDiagnosticWorkerRecycle(worker: Worker, failureCount: number): void {
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
        beginDiagnosticWorkerRecycle(w, nextFailureCount);
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
    if (data.type === "blocklistIdsRead") {
      const reply: BlocklistIdsReadReply = data;
      settleDiskIOReply({
        channel: blocklistIdReadRequests,
        requestId: reply.requestId,
        error: reply.error,
        payload: reply.ids,
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
