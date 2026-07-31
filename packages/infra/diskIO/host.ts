import {
  diskIOFlushBarrier,
  diskIORestartThrottle,
  diskIORuntime,
  pendingFlushFailedDomains,
  pendingJoinLogReads,
  pendingLoad,
  pendingLuckSecrets,
} from "../../cache/main/diskIO";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../../consts/workerSupervisor";
import type {
  DiskBusinessMessage,
  DiskIOMessage,
  DiskIOReply,
  DiskIORecoveryTransport,
  EnsureLuckSecretRequest,
  JoinLogReadReply,
  LoadRequest,
  LoadedReply,
  ReadJoinLogRequest,
} from "../../types/diskIO";
import type { JoinLogRecord, LuckReceiptSecret } from "../../types/diskIO/storage";

/**
 * Disk I/O Worker 的宿主内核（owner 是 packages/infra/diskIO.ts）：Worker 创建、
 * onmessage 回执路由、onerror 崩溃自愈与运行时恢复握手。主文件保留
 * init/post/flush/terminate 与启动握手这一层对外语义。
 *
 * 本文件的错误一律 console.error：它就是落盘终点，不能指望被自己转发的
 * 日志线程落盘自己的错误，否则是一场递归。这也是 Disk I/O 不复用
 * libs/supervisedWorker.ts 通用骨架（其 onerror 走 logger.error）的原因。
 * @see ../../../docs/04-invariants.md
 */

/**
 * Worker.postMessage 可能在本地 owner 仍判定 Worker 可写之后同步抛出；把这个
 * 竞态统一挡在这里，不让它扩散到每一个业务/日志/请求类调用方。
 * @returns 投递是否被 Worker 接受。
 */
export function safePostDiskIO(worker: Worker, message: DiskIOMessage, context: string): boolean {
  try {
    worker.postMessage(message);
    return true;
  } catch (error: unknown) {
    console.error(`[diskIO] persistence Worker rejected ${context}:`, error);
    return false;
  }
}

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
    console.error("[diskIO] fatal persistence failure requires process restart:", error.message);
  }
}

function rejectPendingLuckSecrets(error: Error): void {
  for (const pending of pendingLuckSecrets.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingLuckSecrets.clear();
}

function rejectPendingJoinLogReads(error: Error): void {
  for (const pending of pendingJoinLogReads.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingJoinLogReads.clear();
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
  const requestId: number = diskIORuntime.nextLuckSecretRequestId++;
  return new Promise((
    resolve: (value: LuckReceiptSecret | PromiseLike<LuckReceiptSecret>) => void,
    reject: (reason?: unknown) => void
  ): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      pendingLuckSecrets.delete(requestId);
      reject(new Error(`[diskIO] luck receipt secret request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    pendingLuckSecrets.set(requestId, { resolve, reject, timer });
    if (safePostDiskIO(
      worker,
      { type: "ensureLuckSecret", requestId, day } satisfies EnsureLuckSecretRequest,
      context
    )) {
      return;
    }
    pendingLuckSecrets.delete(requestId);
    clearTimeout(timer);
    reject(new Error(`[diskIO] persistence Worker rejected the ${context}.`));
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
  const requestId: number = diskIORuntime.nextJoinLogReadRequestId++;
  return new Promise((
    resolve: (value: readonly JoinLogRecord[] | PromiseLike<readonly JoinLogRecord[]>) => void,
    reject: (reason?: unknown) => void
  ): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      pendingJoinLogReads.delete(requestId);
      reject(new Error(`[diskIO] join log request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    pendingJoinLogReads.set(requestId, { resolve, reject, timer });
    const request: ReadJoinLogRequest = {
      type: "readJoinLog",
      requestId,
      chatId,
      since,
      now,
    };
    if (safePostDiskIO(worker, request, "join log read request")) return;
    pendingJoinLogReads.delete(requestId);
    clearTimeout(timer);
    reject(new Error("[diskIO] persistence Worker rejected the join log read request."));
  });
}

/**
 * 恢复失败的统一收口：让存储保持不可写、结算所有等待方并终止该实例。
 * @param fatal 是否升级为需要进程重启的致命失败（运行时恢复路径为 true）。
 */
export function stopWorkerAfterLoadFailure(worker: Worker, reason: string, fatal: boolean): void {
  if (diskIORuntime.worker !== worker) return;
  clearRuntimeRecoveryTimer();
  console.error(
    `[diskIO] persistence recovery failed; keeping storage unavailable and refusing writes: ${reason}`
  );
  diskIORuntime.worker = null;
  diskIORuntime.runtimeRecoveryWorker = null;
  diskIORuntime.writable = false;
  diskIORuntime.pendingBusinessMessages.clear();
  diskIOFlushBarrier.settleAll("failed");
  rejectPendingLuckSecrets(new Error(
    `Persistence Worker became unavailable during recovery: ${reason}`
  ));
  rejectPendingJoinLogReads(new Error(
    `Persistence Worker became unavailable during recovery: ${reason}`
  ));
  try {
    void Promise.resolve(worker.terminate()).catch((error: unknown): void => {
      console.error("[diskIO] failed to terminate unusable persistence Worker:", error);
    });
  } catch (error: unknown) {
    console.error("[diskIO] failed to terminate unusable persistence Worker:", error);
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
  const transport: DiskIORecoveryTransport = Object.freeze({
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
  });
  return {
    transport,
    deactivate: (): void => { active = false; },
    failed: (): boolean => transportFailed,
  };
}

function describeRecoveryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function activateDiskIOWorker(worker: Worker, replayMirrors: boolean): Promise<void> {
  if (diskIORuntime.worker !== worker) return;
  if (replayMirrors) {
    // 按登记顺序等待各领域镜像；整个握手保持不可写，恢复 timer 继续覆盖
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
  if (replayMirrors && !isCurrentRecoveryWorker(worker)) return;
  if (!replayMirrors && diskIORuntime.worker !== worker) return;
  clearRuntimeRecoveryTimer();
  diskIORuntime.runtimeRecoveryWorker = null;
  diskIORuntime.writable = true;
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

/** 创建一个落盘 Worker 实例并挂上回执路由与崩溃自愈；不改变 diskIORuntime.worker。 */
export function createDiskIOWorker(): Worker {
  const w: Worker = new Worker(new URL("../../workers/diskIOWorker.ts", import.meta.url).href);
  w.unref();
  w.onmessage = (event: MessageEvent<DiskIOReply>): void => {
    if (diskIORuntime.worker !== w) return;
    const data: DiskIOReply = event.data;
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
    if (data.type === "flushed" || data.type === "flushFailed") {
      // 按领域记账供 flushDiskIODomain 查询：统一 flush 覆盖全部八个领域，
      // 因此后到的回执总是更新的真相，成功回执直接清空。失败领域名也要落进
      // 控制台——Worker 侧的写盘错误按设计只有 console.error，不带领域名的话
      // 运维根本看不出是哪个文件坏了。
      diskIORuntime.lastFlushFailedDomains = data.type === "flushed" ? [] : data.failedDomains;
      if (data.type === "flushFailed") {
        console.error(`[diskIO] flush failed for domain(s): ${data.failedDomains.join(", ")}.`);
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
      const pending: { resolve: (secret: LuckReceiptSecret) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; } | undefined = pendingLuckSecrets.get(data.requestId);
      if (!pending) return;
      pendingLuckSecrets.delete(data.requestId);
      clearTimeout(pending.timer);
      if (data.error !== undefined || data.secret === undefined) {
        pending.reject(new Error(data.error ?? "Disk I/O Worker returned no luck receipt secret."));
      } else {
        pending.resolve(data.secret);
      }
      return;
    }
    if (data.type === "joinLogRead") {
      const pending: {
        resolve: (records: readonly JoinLogRecord[]) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      } | undefined = pendingJoinLogReads.get(data.requestId);
      if (!pending) return;
      pendingJoinLogReads.delete(data.requestId);
      clearTimeout(pending.timer);
      const reply: JoinLogReadReply = data;
      if (reply.error !== undefined || reply.records === undefined) {
        pending.reject(new Error(reply.error ?? "Disk I/O Worker returned no join records."));
      } else {
        pending.resolve(reply.records);
      }
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
    // 已替换旧实例的迟到/重复错误不能再启动第二条并行重建链。
    if (diskIORuntime.worker !== w) return;
    // 落盘线程自己出错时不能再指望它把这条日志落盘，直接走控制台，避免
    // 自己给自己转发出一场递归。Bun 里 Worker 内部一旦抛出未捕获异常
    // （同步或 async 均如此，已实测验证）就会直接终止该 Worker 线程，这里
    // 不需要（实际上也没法）再手动 terminate，直接换一个新实例顶上即可。
    console.error("[diskIO] persistence Worker errored:", event.message || event.error || event);
    diskIORuntime.writable = false;
    if (diskIORuntime.runtimeRecoveryWorker === w) {
      diskIORuntime.runtimeRecoveryWorker = null;
      clearRuntimeRecoveryTimer();
    }
    const pendingFlushCount: number = diskIOFlushBarrier.pendingCount();
    if (pendingFlushCount > 0) {
      // 崩溃这一刻若正好卡着 flushDiskIO 的等待：旧实例内存里的 dirty 数据
      // （上次成功落盘之后攒下的增量）随线程一起没了，新实例读不到、也补不
      // 回来——不能让 flushDiskIO 的调用方（进程退出前的最后一刷）误以为
      // 超时=已落盘。这里立即结算这些 flush（而不是干等 timeoutMs 到期），
      // 并把"这次 flush 实际落空"打进日志，与上面的崩溃日志对齐时间点。
      console.error(
        `[diskIO] ${pendingFlushCount} pending flush(es) lost — persistence Worker crashed mid-flush, their buffered data was not written to disk.`
      );
      diskIOFlushBarrier.settleAll("failed");
    }
    rejectPendingLuckSecrets(
      new Error("Persistence Worker crashed while loading the daily luck receipt secret.")
    );
    rejectPendingJoinLogReads(
      new Error("Persistence Worker crashed while reading join logs.")
    );
    if (diskIORestartThrottle.shouldGiveUp()) {
      console.error(
        `[diskIO] persistence Worker restarted ${WORKER_MAX_RESTARTS} times within ` +
        `${WORKER_RESTART_WINDOW_MS / 1000}s, giving up self-healing and forcing a supervised process restart ` +
        `before any more updates are accepted.`
      );
      diskIORuntime.worker = null;
      diskIORuntime.pendingBusinessMessages.clear();
      signalDiskIOFatal(new Error("Persistence Worker exhausted its runtime restart budget."));
      return;
    }
    const next: Worker = createDiskIOWorker();
    diskIORuntime.worker = next;
    // 崩溃重建后的第一层恢复：新实例缓存全空，先自己读一次盘拿到最后一次
    // 成功落盘的状态。
    beginRuntimeRecovery(next);
  };
  return w;
}
