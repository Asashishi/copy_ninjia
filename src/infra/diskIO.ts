/**
 * 进程唯一的共享数据 Disk I/O Worker 宿主（主线程侧）：统一承载日志、AI/贴纸快照、
 * 每日运势与待验证当日增量 JSON——由 diskIOWorker 在单一 Worker 线程里
 * 串行执行，避免多个业务 Worker 并发写坏共享文件。state.json 是明确例外，
 * 由主线程的 infra/storage/stateStore.ts 独立异步读写与 flush。
 *
 * Worker 拥有权、崩溃自愈的重启节流、flush/load 握手全部收在这里；
 * infra/logger.ts 只是调用方之一（error 日志经 relayLogMessage 投递）。
 * aiChat.ts、commands/luckChallenge/cache.ts 与 antiRaid.ts 经 postDiskIO 投递。
 *
 * 本模块自身的错误一律 console.error（由进程控制台日志兜底）——它就是落盘终点，
 * 不能再指望被自己转发的日志线程落盘自己的错误，否则是一场递归。这也是
 * 本模块不复用 libs/supervisedWorker.ts 通用骨架（其 onerror 走 logger.error）
 * 的原因，需要一份独立的、只用 console 的自愈逻辑。
 * @see ../../docs/04-invariants.md
 */

import {
  diskIOFlushBarrier,
  diskIORestartThrottle,
  diskIORuntime,
  pendingLoad,
  pendingLuckSecrets,
} from "../cache/diskIO";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../consts/workerSupervisor";
import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import type { FlushResult } from "../types/lifecycle";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
  DiskBusinessMessage,
  DiskFlushRequest,
  DiskIOMessage,
  DiskIOReply,
  EnsureLuckSecretRequest,
  LoadRequest,
  LoadedReply,
  LogEnvelope,
  LogMessage,
  VerificationPersistedReply,
} from "../types/diskIO";
import type { VerificationSnapshot } from "../types/antiRaid";
import type { LuckDayCache, LuckReceiptSecret } from "../types/diskIO/storage";

const isMainThread: boolean = Bun.isMainThread;
export interface DiskIOInitOptions {
  /** 运行时恢复无法继续时通知应用停止；启动握手失败仍由 loadPersistedData reject。 */
  onFatal?: (error: Error) => void;
  /** 仅供测试缩短；生产默认与启动 load 握手使用同一预算。 */
  runtimeRecoveryTimeoutMs?: number;
  /** 恢复窗口内的业务增量硬顶，避免失联 Worker 造成无界内存增长。 */
  maxPendingBusinessMessages?: number;
}

// 落盘 Worker 只能由入口在取得 bot.lock 后显式初始化。模块导入本身不得
// 创建线程：否则竞争单实例锁失败的第二进程仍会执行 diskIOWorker 顶层的
// initLogFiles()，提前创建/清扫共享 logs/ 目录。Worker 线程里永远不初始化
// 本宿主，只使用 logger.ts 的转发模式。
function requirePositiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number.`);
  return value;
}

/**
 * 在主线程显式启动唯一的落盘 Worker。调用方必须已经取得数据目录的
 * bot.lock；重复调用幂等，不能借重复初始化绕过崩溃自愈的放弃阈值。
 */
export function initDiskIO({
  onFatal,
  runtimeRecoveryTimeoutMs = LOAD_TIMEOUT_MS,
  maxPendingBusinessMessages = DEFAULT_MAX_PENDING_BUSINESS_MESSAGES,
}: DiskIOInitOptions = {}): void {
  if (!isMainThread) {
    throw new Error("Disk I/O can only be initialized by the main thread.");
  }
  if (diskIORuntime.initialized) return;
  const nextRuntimeRecoveryTimeoutMs: number = requirePositiveFinite(
    runtimeRecoveryTimeoutMs,
    "Disk I/O runtime recovery timeout"
  );
  if (!Number.isSafeInteger(maxPendingBusinessMessages) || maxPendingBusinessMessages < 1) {
    throw new RangeError("Disk I/O pending business message capacity must be a positive safe integer.");
  }
  diskIORuntime.fatalHandler = onFatal;
  diskIORuntime.runtimeRecoveryTimeoutMs = nextRuntimeRecoveryTimeoutMs;
  diskIORuntime.maxPendingBusinessMessages = maxPendingBusinessMessages;
  diskIORuntime.fatalSignaled = false;
  diskIORuntime.writable = false;
  diskIORuntime.worker = createDiskIOWorker();
  diskIORuntime.initialized = true;
}

/** 供入口生命周期守卫和无副作用 import 测试查询，不代表 Worker 当前可用。 */
export function isDiskIOInitialized(): boolean {
  return diskIORuntime.initialized;
}

function createDiskIOWorker(): Worker {
  const w: Worker = new Worker(new URL("../workers/diskIOWorker.ts", import.meta.url).href);
  w.unref();
  w.onmessage = (event: MessageEvent<DiskIOReply>) => {
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
      diskIOFlushBarrier.settle(data.flushedId, data.type === "flushed" ? "flushed" : "failed");
      return;
    }
    if (data.type === "luckSecret") {
      const pending = pendingLuckSecrets.get(data.requestId);
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
    // data.type === "loaded"：启动和运行时重建都必须先验证完整恢复结果，
    // 任何领域失败时都不能进入 writable，也不能重放可能覆盖旧数据的镜像。
    const resolve = pendingLoad.resolve;
    if (resolve) {
      pendingLoad.resolve = null;
      pendingLoad.reject = null;
      if (pendingLoad.timer !== null) clearTimeout(pendingLoad.timer);
      pendingLoad.timer = null;
      resolve(data);
      if (isSuccessfulLoad(data)) activateDiskIOWorker(w, false);
      else stopWorkerAfterLoadFailure(w, data.error ?? "no luck receipt secret returned", false);
      return;
    }
    if (diskIORuntime.runtimeRecoveryWorker !== w) return;
    if (!isSuccessfulLoad(data)) {
      stopWorkerAfterLoadFailure(w, data.error ?? "no luck receipt secret returned", true);
      return;
    }
    activateDiskIOWorker(w, true);
  };
  w.onerror = (event: ErrorEvent) => {
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
    if (pendingLuckSecrets.size > 0) {
      const error = new Error("Persistence Worker crashed while loading the daily luck receipt secret.");
      for (const pending of pendingLuckSecrets.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      pendingLuckSecrets.clear();
    }
    if (diskIORestartThrottle.shouldGiveUp()) {
      console.error(
        `[diskIO] persistence Worker restarted ${WORKER_MAX_RESTARTS} times within ` +
        `${WORKER_RESTART_WINDOW_MS / 1000}s, giving up self-healing and forcing a supervised process restart ` +
        `before any more updates are accepted.`
      );
      diskIORuntime.worker = null;
      diskIORuntime.pendingBusinessMessages.length = 0;
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

function isSuccessfulLoad(reply: LoadedReply): boolean {
  return reply.error === undefined && reply.luckReceiptSecret !== null;
}

function activateDiskIOWorker(worker: Worker, replayMirrors: boolean): void {
  if (diskIORuntime.worker !== worker) return;
  clearRuntimeRecoveryTimer();
  diskIORuntime.runtimeRecoveryWorker = null;
  diskIORuntime.writable = true;
  if (replayMirrors) {
    // load 已完整成功，此时才允许各领域把崩溃窗口内的主线程镜像补齐。
    for (const listener of diskIORuntime.respawnListeners) {
      try {
        listener();
      } catch (error: unknown) {
        console.error("[diskIO] failed to replay a persistence mirror after recovery:", error);
      }
      if (diskIORuntime.worker !== worker || !diskIORuntime.writable) return;
    }
  }
  while (diskIORuntime.pendingBusinessMessages.length > 0) {
    const message: DiskBusinessMessage = diskIORuntime.pendingBusinessMessages[0]!;
    if (!safePostDiskIO(worker, message, `replay ${message.type}`)) {
      stopWorkerAfterLoadFailure(worker, `Worker rejected ${message.type} during recovery replay`, true);
      return;
    }
    diskIORuntime.pendingBusinessMessages.shift();
  }
}

/**
 * Worker.postMessage 可能在本地 owner 仍判定 Worker 可写之后同步抛出；把这个
 * 竞态统一挡在这里，不让它扩散到每一个业务/日志/请求类调用方。
 */
function safePostDiskIO(worker: Worker, message: DiskIOMessage, context: string): boolean {
  try {
    worker.postMessage(message);
    return true;
  } catch (error: unknown) {
    console.error(`[diskIO] persistence Worker rejected ${context}:`, error);
    return false;
  }
}

function clearRuntimeRecoveryTimer(): void {
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

function beginRuntimeRecovery(worker: Worker): void {
  clearRuntimeRecoveryTimer();
  diskIORuntime.runtimeRecoveryWorker = worker;
  diskIORuntime.runtimeRecoveryTimer = setTimeout(() => {
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

function stopWorkerAfterLoadFailure(worker: Worker, reason: string, fatal: boolean): void {
  if (diskIORuntime.worker !== worker) return;
  clearRuntimeRecoveryTimer();
  console.error(
    `[diskIO] persistence recovery failed; keeping storage unavailable and refusing writes: ${reason}`
  );
  diskIORuntime.worker = null;
  diskIORuntime.runtimeRecoveryWorker = null;
  diskIORuntime.writable = false;
  diskIORuntime.pendingBusinessMessages.length = 0;
  diskIOFlushBarrier.settleAll("failed");
  try {
    void Promise.resolve(worker.terminate()).catch((error: unknown) => {
      console.error("[diskIO] failed to terminate unusable persistence Worker:", error);
    });
  } catch (error: unknown) {
    console.error("[diskIO] failed to terminate unusable persistence Worker:", error);
  }
  if (fatal) signalDiskIOFatal(new Error(`[diskIO] runtime persistence recovery failed: ${reason}`));
}

/**
 * 注册一个回调：diskIOWorker 崩溃重建后调用，用于把主线程侧的镜像
 * （AI 记忆 latestAiMemories、运势 dailyLuckCache、待验证 active/终结变化）
 * 重新投递给新实例，补齐上一次成功落盘之后的增量。落盘 Worker 是唯一的
 * 单例，各领域各自登记一个回调即可。
 */
export function onDiskIORespawn(callback: () => void): void {
  diskIORuntime.respawnListeners.push(callback);
}

/** 注册待验证增量 JSON 真正写入后的确认回调。 */
export function onVerificationPersisted(callback: (reply: VerificationPersistedReply) => void): void {
  diskIORuntime.verificationPersistedListeners.push(callback);
}

/** 注册 AI 记忆删除真正 durable（或被更新 revision 覆盖）的确认回调。 */
export function onAiMemoryDeletedPersisted(callback: (reply: AiMemoryDeletedPersistedReply) => void): void {
  diskIORuntime.aiMemoryDeletedPersistedListeners.push(callback);
}

/** 注册 purge 后首份新 AI 记忆真正 durable 的确认回调。 */
export function onAiMemoryPersisted(callback: (reply: AiMemoryPersistedReply) => void): void {
  diskIORuntime.aiMemoryPersistedListeners.push(callback);
}

/** 把其它 Worker 线程转发来的 error 日志转投落盘线程（logger.ts 的转发模式，仅主线程调用）。 */
export function relayLogMessage(message: LogMessage): boolean {
  const worker: Worker | null = diskIORuntime.worker;
  if (worker === null || !diskIORuntime.writable) return false;
  // 日志转投绝不能递归调用 logger，也不能把落盘故障升级成应用 fatal；
  // safePostDiskIO 的 console 诊断是这条路径的最终兜底。
  return safePostDiskIO(worker, { type: "log", ...message } satisfies LogEnvelope, "log message");
}

/** 主线程 -> diskIOWorker：统一的快照或增量写入。 */
export function postDiskIO(
  message: DiskBusinessMessage
): boolean {
  const worker: Worker | null = diskIORuntime.worker;
  if (worker === null) return false;
  if (!diskIORuntime.writable) {
    if (diskIORuntime.pendingBusinessMessages.length >= diskIORuntime.maxPendingBusinessMessages) {
      stopWorkerAfterLoadFailure(
        worker,
        `buffered business message limit (${diskIORuntime.maxPendingBusinessMessages}) exceeded during recovery`,
        true
      );
      return false;
    }
    diskIORuntime.pendingBusinessMessages.push(message);
    return true;
  }
  if (safePostDiskIO(worker, message, `${message.type} business message`)) return true;
  stopWorkerAfterLoadFailure(worker, `Worker synchronously rejected ${message.type}`, true);
  return false;
}

/** 两张快照表的值是序列化 JSON 文本（与消息协议同形态，见 types/aiChat.ts
 *  的 AiMemoryEvent.snapshot），hydrate 链路直接透传，解析发生在 aiChatWorker
 *  侧的灌入点。 */
export interface LoadedData {
  aiMemories: Map<number, string>;
  stickerCatalogs: Map<string, string>;
  luckDay: LuckDayCache | null;
  luckReceiptSecret: LuckReceiptSecret;
  verifications: Map<string, VerificationSnapshot>;
}

/**
 * 启动恢复：向 diskIOWorker 请求上一次成功落盘的全部状态，带超时兜底。
 * 必须在 runner 开始投喂更新之前调用并等待完成（见 app/lifecycle.ts）——尤其是
 * 运势缓存与待验证记录都必须先恢复，避免重复抽签或遗漏超时处置。
 * 超时或 Worker 不存在时拒绝启动。持久化恢复不能降级为空状态继续：迟到的
 * load 回执不会再被主线程接管，后续新快照会覆盖磁盘上的旧记忆，造成静默
 * 数据丢失；交给 app/lifecycle.ts 的 run().catch 以非零码退出并由进程管理器重试。
 */
export function loadPersistedData(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<LoadedData> {
  requirePositiveFinite(timeoutMs, "Disk I/O load timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker) {
    return Promise.reject(new Error("Persistence Worker is unavailable; refusing to start with empty persisted state."));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLoad.resolve = null;
      pendingLoad.reject = null;
      pendingLoad.timer = null;
      reject(new Error(`[diskIO] load handshake timed out after ${timeoutMs}ms; refusing to start with empty persisted state.`));
    }, timeoutMs);
    pendingLoad.timer = timer;
    pendingLoad.reject = reject;
    pendingLoad.resolve = (reply: LoadedReply): void => {
      if (reply.error !== undefined) {
        reject(new Error(`[diskIO] persistence recovery failed: ${reply.error}`));
        return;
      }
      if (reply.luckReceiptSecret === null) {
        reject(new Error("[diskIO] persistence recovery returned no luck receipt secret."));
        return;
      }
      resolve({
        aiMemories: reply.aiMemories,
        stickerCatalogs: reply.stickerCatalogs,
        luckDay: reply.luckDay,
        luckReceiptSecret: reply.luckReceiptSecret,
        verifications: reply.verifications,
      });
    };
    const request: LoadRequest = { type: "load" };
    if (!safePostDiskIO(worker, request, "startup load request")) {
      pendingLoad.resolve = null;
      pendingLoad.reject = null;
      pendingLoad.timer = null;
      clearTimeout(timer);
      reject(new Error("[diskIO] persistence Worker rejected the startup load request."));
    }
  });
}

/** 东京日期切换后，经唯一 Disk I/O Worker 原子加载或轮换日级运势密钥。 */
export function ensureLuckReceiptSecret(
  day: string,
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<LuckReceiptSecret> {
  requirePositiveFinite(timeoutMs, "Luck receipt secret timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) {
    return Promise.reject(new Error("Persistence Worker is unavailable; cannot rotate luck receipt secret."));
  }
  const requestId: number = diskIORuntime.nextLuckSecretRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLuckSecrets.delete(requestId);
      reject(new Error(`[diskIO] luck receipt secret request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    pendingLuckSecrets.set(requestId, { resolve, reject, timer });
    if (!safePostDiskIO(
      worker,
      { type: "ensureLuckSecret", requestId, day } satisfies EnsureLuckSecretRequest,
      "luck receipt secret request"
    )) {
      pendingLuckSecrets.delete(requestId);
      clearTimeout(timer);
      reject(new Error("[diskIO] persistence Worker rejected the luck receipt secret request."));
    }
  });
}

/**
 * 要求 diskIOWorker 立即把所有 dirty 数据（含待验证增量）全部落盘，
 * 并等待完成。用于进程退出前的最后一刷。带超时兜底：
 * Worker 异常时停机流程最多被拖住 timeoutMs，不会挂死。resolve 只代表
 * "等待已结束"；返回值明确区分成功、超时与失败。Worker 若恰好在这次
 * flush 期间崩溃，onerror 会立即以 failed 结算并记录数据未落盘。
 */
export function flushDiskIO(timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS): Promise<FlushResult> {
  requirePositiveFinite(timeoutMs, "Disk I/O flush timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) return Promise.resolve("failed");
  return diskIOFlushBarrier.begin((id) => {
    const request: DiskFlushRequest = { type: "flush", flushId: id };
    return safePostDiskIO(worker, request, "flush request");
  }, timeoutMs);
}

/** 终止落盘 Worker；返回后旧实例不可能再 rename/append 共享文件。 */
export function terminateDiskIO(): Promise<void> {
  const worker: Worker | null = diskIORuntime.worker;
  diskIORuntime.worker = null;
  diskIORuntime.initialized = false;
  diskIORuntime.writable = false;
  diskIORuntime.runtimeRecoveryWorker = null;
  clearRuntimeRecoveryTimer();
  diskIORuntime.fatalHandler = undefined;
  diskIORuntime.fatalSignaled = false;
  diskIORuntime.runtimeRecoveryTimeoutMs = LOAD_TIMEOUT_MS;
  diskIORuntime.maxPendingBusinessMessages = DEFAULT_MAX_PENDING_BUSINESS_MESSAGES;
  diskIORuntime.pendingBusinessMessages.length = 0;
  diskIORuntime.nextLuckSecretRequestId = 1;
  diskIOFlushBarrier.settleAll("failed");
  const terminationError = new Error("Persistence Worker terminated before the request completed.");
  if (pendingLoad.timer !== null) clearTimeout(pendingLoad.timer);
  pendingLoad.timer = null;
  pendingLoad.resolve = null;
  pendingLoad.reject?.(terminationError);
  pendingLoad.reject = null;
  for (const pending of pendingLuckSecrets.values()) {
    clearTimeout(pending.timer);
    pending.reject(terminationError);
  }
  pendingLuckSecrets.clear();
  if (worker === null) return Promise.resolve();
  try {
    worker.terminate();
    return Promise.resolve();
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error("Persistence Worker termination failed."));
  }
}
