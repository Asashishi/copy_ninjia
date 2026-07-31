/**
 * 进程唯一的共享数据 Disk I/O Worker 宿主（主线程侧）：统一承载日志、AI/贴纸快照、
 * 每日运势、待验证当日增量 JSON 与 /block 黑名单——由 diskIOWorker 在单一 Worker 线程里
 * 串行执行，避免多个业务 Worker 并发写坏共享文件。state.json 是明确例外，
 * 由主线程的 infra/storage/stateStore.ts 独立异步读写与 flush。
 *
 * Worker 拥有权、flush/load 握手与对外投递语义收在本文件；Worker 创建、
 * 回执路由与崩溃自愈的重启节流在 infra/diskIO/host.ts。
 * infra/logger.ts 只是调用方之一（error 日志经 relayLogMessage 投递）。
 * aiChat/index.ts、commands/luckChallenge/cache.ts、antiRaid/index.ts 与
 * infra/blocklist.ts 经 postDiskIO 投递。
 *
 * 本模块自身的错误一律 console.error（由进程控制台日志兜底）——它就是落盘终点，
 * 不能再指望被自己转发的日志线程落盘自己的错误，否则是一场递归。这也是
 * 本模块不复用 libs/supervisedWorker.ts 通用骨架（其 onerror 走 logger.error）
 * 的原因，需要一份独立的、只用 console 的自愈逻辑。
 * @see ../../docs/04-invariants.md
 */

import {
  diskIOFlushBarrier,
  diskIORuntime,
  pendingFlushFailedDomains,
  pendingJoinLogReads,
  pendingLoad,
  pendingLuckSecrets,
} from "../cache/main/diskIO";
import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import {
  clearRuntimeRecoveryTimer,
  createDiskIOWorker,
  requestJoinLogFromWorker,
  requestLuckSecretFromWorker,
  safePostDiskIO,
  stopWorkerAfterLoadFailure,
} from "./diskIO/host";
import type { FlushResult } from "../types/lifecycle";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
  DiskBusinessMessage,
  DiskFlushRequest,
  DiskIODomain,
  DiskIORespawnListener,
  LoadRequest,
  LoadedData,
  LoadedReply,
  LogEnvelope,
  LogMessage,
  VerificationPersistedReply,
} from "../types/diskIO";
import type {
  JoinLogRecord,
  LuckReceiptSecret,
} from "../types/diskIO/storage";

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

/**
 * 注册一个恢复 listener：diskIOWorker 崩溃重建后调用，用于把主线程侧的镜像
 * （AI 记忆 latestAiMemories、运势 dailyLuckCache、待验证 active/终结变化）
 * 重新投递给新实例，补齐上一次成功落盘之后的增量。listener 必须等待本领域
 * 全部异步工作并明确返回成败；普通 postDiskIO 会进入恢复缓冲，镜像重放只能
 * 使用传入的 scoped transport。落盘 Worker 是唯一单例，各领域登记一次即可。
 */
export function onDiskIORespawn(owner: string, listener: DiskIORespawnListener): void {
  diskIORuntime.respawnListeners.push({ owner, listener });
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

/**
 * 主线程 -> diskIOWorker：投递一条**允许丢**的诊断消息（目前只有广告命中样本）。
 *
 * 与 postDiskIO 的差别只在失败语义：Worker 不可写时直接丢，既不占
 * pendingBusinessMessages 的恢复预算，也绝不触发 stopWorkerAfterLoadFailure
 * ——同 relayLogMessage 的取舍。这类消息体积最大、命中时最密集，走 postDiskIO
 * 就是拿一个契约上「丢了也不影响任何行为」的诊断去抢安全任务的恢复缓冲，
 * 触顶还会把进程连同未确认的 update 一起带走。
 * @returns 是否真的投出去了；调用方只用来记一行日志，不据此重试。
 */
export function postDiskIODiagnostic(message: DiskBusinessMessage): boolean {
  const worker: Worker | null = diskIORuntime.worker;
  if (worker === null || !diskIORuntime.writable) return false;
  return safePostDiskIO(worker, message, `${message.type} diagnostic message`);
}

/** 主线程 -> diskIOWorker：统一的快照或增量写入。 */
export function postDiskIO(
  message: DiskBusinessMessage
): boolean {
  const worker: Worker | null = diskIORuntime.worker;
  if (worker === null) return false;
  if (!diskIORuntime.writable) {
    if (diskIORuntime.pendingBusinessMessages.size >= diskIORuntime.maxPendingBusinessMessages) {
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
  return new Promise((resolve: (value: LoadedData | PromiseLike<LoadedData>) => void, reject: (reason?: unknown) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
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
        blockedUsers: reply.blockedUsers,
        pendingBlockedRemovals: reply.pendingBlockedRemovals,
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
  return requestLuckSecretFromWorker({
    worker,
    day,
    timeoutMs,
    context: "luck receipt secret request",
  });
}

export interface ReadJoinLogParams {
  chatId: number;
  since: number;
  now: number;
  timeoutMs?: number;
}

/**
 * 仅供 `/batch_kick` 按需读取本群滚动 24 小时入群日志；Worker 会先提交更早到达的
 * 追写缓冲，因此返回值覆盖命令请求之前已经处理的全部入群事件。
 */
export function readJoinLog({
  chatId,
  since,
  now,
  timeoutMs = LOAD_TIMEOUT_MS,
}: ReadJoinLogParams): Promise<readonly JoinLogRecord[]> {
  requirePositiveFinite(timeoutMs, "Join log read timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) {
    return Promise.reject(
      new Error("Persistence Worker is unavailable; cannot read join logs.")
    );
  }
  return requestJoinLogFromWorker({
    worker,
    chatId,
    since,
    now,
    timeoutMs,
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
  return requestDiskIOFlush(timeoutMs).then(
    (outcome: DiskIOFlushOutcome): FlushResult => outcome.result
  );
}

interface DiskIOFlushOutcome {
  result: FlushResult;
  /** 仅在 Worker 明确回复本次请求部分失败时存在。 */
  failedDomains?: readonly DiskIODomain[];
}

async function requestDiskIOFlush(
  timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS
): Promise<DiskIOFlushOutcome> {
  requirePositiveFinite(timeoutMs, "Disk I/O flush timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) return { result: "failed" };
  let flushId: number | null = null;
  const result: FlushResult = await diskIOFlushBarrier.begin((id: number): boolean => {
    flushId = id;
    const request: DiskFlushRequest = { type: "flush", flushId: id };
    return safePostDiskIO(worker, request, "flush request");
  }, timeoutMs);
  if (flushId === null) return { result };
  const failedDomains: readonly DiskIODomain[] | undefined =
    pendingFlushFailedDomains.get(flushId);
  pendingFlushFailedDomains.delete(flushId);
  return failedDomains === undefined ? { result } : { result, failedDomains };
}

/**
 * 只关心某一个领域有没有落盘的 flush。仍然触发统一 flush（Worker 那边本来
 * 就是八个领域一起刷），但把「无关领域失败」判成成功。
 *
 * 存在的理由：`flushAll` 是八个领域的合取，任何一个失败（典型是某群
 * `memory/ai/<chat>.json` 部署后属主不对）都会让 /block 报「小本本没能写进
 * 硬盘」，把运维引向一个其实没坏的文件。
 * @returns 该领域已 durable 为 "flushed"；"timedOut"/"failed" 表示没写进去。
 */
export async function flushDiskIODomain(
  domain: DiskIODomain,
  timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS
): Promise<FlushResult> {
  const outcome: DiskIOFlushOutcome = await requestDiskIOFlush(timeoutMs);
  if (outcome.result !== "failed") return outcome.result;
  if (outcome.failedDomains === undefined) return "failed";
  return outcome.failedDomains.includes(domain) ? "failed" : "flushed";
}

/** 最近一次 flush 回执里没能落盘的领域，供调用方把真正坏掉的那个记进日志。 */
export function lastFailedDiskIODomains(): readonly DiskIODomain[] {
  return diskIORuntime.lastFlushFailedDomains;
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
  diskIORuntime.pendingBusinessMessages.clear();
  diskIORuntime.nextLuckSecretRequestId = 1;
  diskIORuntime.nextJoinLogReadRequestId = 1;
  diskIORuntime.lastFlushFailedDomains = [];
  diskIOFlushBarrier.settleAll("failed");
  pendingFlushFailedDomains.clear();
  const terminationError: Error = new Error("Persistence Worker terminated before the request completed.");
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
  for (const pending of pendingJoinLogReads.values()) {
    clearTimeout(pending.timer);
    pending.reject(terminationError);
  }
  pendingJoinLogReads.clear();
  if (worker === null) return Promise.resolve();
  try {
    worker.terminate();
    return Promise.resolve();
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error("Persistence Worker termination failed."));
  }
}
