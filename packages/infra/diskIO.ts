/**
 * 进程唯一的共享数据 Disk I/O Worker 宿主（主线程侧）：统一承载日志、AI/贴纸快照、
 * 每日运势、待验证当日增量 JSON、群状态与 /block 黑名单，由 diskIOWorker 在单一 Worker
 * 线程里串行执行。全局状态 memory/global/state.json
 * 由主线程经 infra/storage/stateStore.ts 门面交给 statePersistence.ts 独立异步读写与 flush。
 *
 * Worker 拥有权、flush/load 握手与对外投递语义收在本文件；Worker 创建与回执路由在
 * infra/diskIO/host.ts，逐请求投递与回执结算在 infra/diskIO/requests.ts，业务与请求的传输队列在
 * infra/diskIO/transport.ts，诊断 FIFO 在 infra/diskIO/diagnosticChannel.ts，恢复握手、
 * 镜像重放与崩溃自愈的重启节流在 infra/diskIO/recovery.ts。
 * infra/logger.ts 只是调用方之一：initDiskIO 把 relayLogMessage 装进 cache/perThread/logger.ts 的
 * logRelaySink，主线程 error 日志经它投递。
 * 各主线程领域 owner（如 aiChat/memoryMirror.ts、antiRaid/verificationMirror.ts、
 * commands/wed/persistence.ts、infra/joinLog.ts、infra/identityStorage/write.ts）经
 * postDiskIO 投递，恢复镜像重放经 infra/diskIO/businessWrite.ts 的 postWithTransport。
 *
 * 本模块自身的错误一律经 workers/diskIO/diagnosticSink.ts 的 writeDiskIODiagnostic
 * （console.error）输出，不经 logger 转发。崩溃自愈同样只用该出口，不经
 * infra/supervisedWorker.ts 通用骨架。
 * @see ../../docs/cn/04-invariants.md
 */

import {
  blocklistIdPageReadRequests,
  diskIOFlushBarrier,
  diskIORuntime,
  identityPolicyReadRequests,
  joinLogReadRequests,
  pendingFlushFailedDomains,
  pendingLoad,
  storageCloseRequests,
} from "../cache/main/diskIO";
import { logRelaySink } from "../cache/perThread/logger";
import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS, DISK_IO_STORAGE_CLOSE_TIMEOUT_MS } from "../consts/lifecycle";
import { createDiskIOWorker } from "./diskIO/host";
import { clearRuntimeRecoveryTimer, stopWorkerAfterLoadFailure } from "./diskIO/recovery";
import {
  rejectAllPendingDiskIORequests,
  requestDiskIO,
  requestLuckSecretFromWorker,
} from "./diskIO/requests";
import {
  enqueueDiskIODiagnostic,
  resetDiskIODiagnosticChannel,
  waitForDiskIODiagnostics,
} from "./diskIO/diagnosticChannel";
import {
  beginDiskIOFlush,
  fitsDiskIOBusiness,
  queueDiskIOOperationMessage,
  resetDiskIOOperations,
  safePostDiskIO,
} from "./diskIO/transport";
import { AcknowledgedBatchQueue } from "../libs/acknowledgedBatchQueue";
import { diskIOMessageCost } from "../libs/diskIOMessageCost";
import { DISK_OPERATION_CONTROL_RESERVE, DISK_BUSINESS_BATCH_MAX_MESSAGES, DISK_OPERATION_MAX_RETAINED_BYTES } from "../consts/diskIO/business";
import { stickerPacksForRecovery } from "../config/stickers";
import { getTimeZone } from "../config/time";
export {
  onDiskIOGiveUp,
  onDiskIOReply,
  onDiskIORespawn,
} from "./diskIO/observers";
import type { FlushResult } from "../types/lifecycle";
import type {
  CloseStorageRequest,
  DiskBusinessMessage,
  DiskFlushScope,
  LoadRequest,
  QueuedDiskIOOperationMessage,
  AdSampleDiskMessage,
  AiCacheUsageDiskMessage,
  LogMessage,
  ReadBlocklistIdPageRequest,
  ReadIdentityPoliciesRequest,
  ReadJoinLogRequest,
} from "../types/diskIO/messages";
import type {
  DiskIODomain,
  DomainFlushOutcome,
  LoadedData,
  LoadedReply,
  StorageCloseOutcome,
} from "../types/diskIO/replies";
import type {
  JoinLogRecord,
  LuckReceiptSecret,
} from "../types/diskIO/storage";
import type { BlocklistIdPage, IdentityPolicyRawReadResult } from "../types/identityStorage";
import { toErrorOr } from "../libs/errorMessage";
import { writeDiskIODiagnostic } from "../workers/diskIO/diagnosticSink";

const isMainThread: boolean = Bun.isMainThread;
export interface DiskIOInitOptions {
  /** 运行时恢复无法继续时通知应用停止；启动握手失败仍由 loadPersistedData reject。 */
  onFatal?: (error: Error) => void;
  /** 仅供测试缩短；生产默认与启动 load 握手使用同一预算。 */
  runtimeRecoveryTimeoutMs?: number;
  /** 排队、在途与恢复窗口合计的业务消息上限。 */
  maxPendingBusinessMessages?: number;
}

function requirePositiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number.`);
  return value;
}

/**
 * 在主线程显式启动唯一的落盘 Worker，并把 relayLogMessage 装成 logger 的落盘出口。调用方必须
 * 已经取得数据目录的 bot.lock；重复调用幂等，不重置崩溃自愈的放弃阈值。
 * 模块导入本身不创建线程；Worker 线程不初始化本宿主，只使用 logger.ts 的转发模式。
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
  diskIORuntime.operationQueue = new AcknowledgedBatchQueue<QueuedDiskIOOperationMessage>({
    maxBatchMessages: DISK_BUSINESS_BATCH_MAX_MESSAGES,
    maxMessages: maxPendingBusinessMessages + DISK_OPERATION_CONTROL_RESERVE,
    maxCost: DISK_OPERATION_MAX_RETAINED_BYTES,
  });
  diskIORuntime.fatalSignaled = false;
  diskIORuntime.consecutiveDiagnosticWriteFailures = 0;
  diskIORuntime.consecutiveDiagnosticRebuilds = 0;
  diskIORuntime.diagnosticRecycleWorker = null;
  diskIORuntime.writable = false;
  diskIORuntime.worker = createDiskIOWorker();
  diskIORuntime.initialized = true;
  logRelaySink.current = relayLogMessage;
}

/** 供入口生命周期守卫和无副作用 import 测试查询，不代表 Worker 当前可用。 */
export function isDiskIOInitialized(): boolean {
  return diskIORuntime.initialized;
}

/**
 * 把 error 日志交给主线程有界 FIFO：主线程自身的日志由 logger.ts 直接调用，其它 Worker
 * 线程转发来的日志由 infra/supervisedWorker.ts 调用（logger.ts 的转发模式）。
 * DiskIO Worker 不可写、崩溃或同步拒收时延后重投；容量越界时释放原消息引用并
 * 记入后续汇总，本函数仍返回已接管，来源 Worker 随即释放原批。
 */
export function relayLogMessage(message: LogMessage): boolean {
  // DiskIO owner 未初始化时返回 false，不建立积压。业务 Worker 在 DiskIO
  // 初始化完成后才启动，运行期转发不经过这个分支。
  if (!diskIORuntime.initialized) return false;
  return enqueueDiskIODiagnostic({ type: "log", id: crypto.randomUUID(), ...message });
}

/**
 * 主线程 -> diskIOWorker：排队一条不进入业务恢复缓冲的旁路诊断（广告命中样本与 AI 缓存用量）。
 *
 * 与 postDiskIO 的差别是它进入独立有界 FIFO，不占 pendingBusinessMessages 的
 * 恢复预算，也不触发业务 fatal；Worker 代际失败后原批重发，容量越界则记入
 * 一条后续汇总。样本文件与用量统计是尽力投递的旁路数据，
 * 见 workers/diskIO/adSampleFile.ts 与 workers/diskIO/aiCacheFile.ts。
 * @returns 已由有界诊断通道接管；调用方无需自行重试。
 */
export function postDiskIODiagnostic(message: AdSampleDiskMessage | AiCacheUsageDiskMessage): boolean {
  if (!diskIORuntime.initialized) return false;
  return enqueueDiskIODiagnostic(message);
}

/** 主线程 -> diskIOWorker：统一的快照或增量写入；载荷成本只算一次，准入与排队共用。 */
export function postDiskIO(
  message: DiskBusinessMessage
): boolean {
  const worker: Worker | null = diskIORuntime.worker;
  if (worker === null) return false;
  const cost: number = diskIOMessageCost(message);
  if (!fitsDiskIOBusiness(cost)) return false;
  if (!diskIORuntime.writable) {
    diskIORuntime.pendingBusinessMessages.push(message);
    diskIORuntime.pendingBusinessBytes += cost;
    return true;
  }
  if (queueDiskIOOperationMessage(worker, message, cost)) return true;
  stopWorkerAfterLoadFailure(worker, `Worker synchronously rejected ${message.type}`, true);
  return false;
}

/**
 * 启动恢复：向 diskIOWorker 请求上一次成功落盘的全部状态，带超时。
 * 必须在 runner 开始投喂更新之前调用并等待完成（见 app/lifecycle.ts）。
 * 超时、Worker 不存在或恢复回执带 error 时 reject，调用方不得以空状态继续启动。
 */
export function loadPersistedData(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<LoadedData> {
  requirePositiveFinite(timeoutMs, "Disk I/O load timeout");
  // pendingLoad 是单槽，同一时刻只允许一个启动 load 请求。
  if (pendingLoad.timer !== null) {
    throw new Error("[diskIO] a startup load request is already pending.");
  }
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker) {
    return Promise.reject(new Error("Persistence Worker is unavailable; refusing to start with empty persisted state."));
  }
  const request: LoadRequest = { type: "load", timeZone: getTimeZone(), stickerPacks: stickerPacksForRecovery() };
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
        wedMembers: reply.wedMembers,
        aiMemories: reply.aiMemories,
        stickerCatalogs: reply.stickerCatalogs,
        luckDay: reply.luckDay,
        luckReceiptSecret: reply.luckReceiptSecret,
        verifications: reply.verifications,
        pendingBlockedRemovals: reply.pendingBlockedRemovals,
        blocklistEntryCount: reply.blocklistEntryCount,
        permissionEntryCount: reply.permissionEntryCount,
        chatStates: reply.chatStates,
        chatQa: reply.chatQa,
      });
    };
    if (!safePostDiskIO(worker, request, "startup load request")) {
      pendingLoad.resolve = null;
      pendingLoad.reject = null;
      pendingLoad.timer = null;
      clearTimeout(timer);
      reject(new Error("[diskIO] persistence Worker rejected the startup load request."));
    }
  });
}

/** requestFromWritableWorker 的入参。 */
interface WritableWorkerRequestParams<T> {
  readonly timeoutMs: number;
  /** 超时预算非法时报错用的名字。 */
  readonly timeoutLabel: string;
  /** 代际不可写时拒绝文案里的动作（`cannot <action>`）。 */
  readonly action: string;
  readonly request: (worker: Worker) => Promise<T>;
}

/**
 * 公开读取入口共用的前置：同步校验超时预算，只向当前可写代际发请求；不可写时以
 * `Persistence Worker is unavailable; cannot <action>.` 拒绝。
 */
function requestFromWritableWorker<T>({
  timeoutMs,
  timeoutLabel,
  action,
  request,
}: WritableWorkerRequestParams<T>): Promise<T> {
  requirePositiveFinite(timeoutMs, timeoutLabel);
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) {
    return Promise.reject(new Error(`Persistence Worker is unavailable; cannot ${action}.`));
  }
  return request(worker);
}

/** 配置时区的日期切换后，经唯一 Disk I/O Worker 原子加载或轮换日级运势密钥。 */
export function ensureLuckReceiptSecret(
  day: string,
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<LuckReceiptSecret> {
  return requestFromWritableWorker({
    timeoutMs,
    timeoutLabel: "Luck receipt secret timeout",
    action: "rotate luck receipt secret",
    request: (worker: Worker): Promise<LuckReceiptSecret> => requestLuckSecretFromWorker({
      worker,
      day,
      timeoutMs,
      context: "luck receipt secret request",
    }),
  });
}

export interface ReadJoinLogParams {
  chatId: number;
  since: number;
  now: number;
  timeoutMs?: number;
}

/**
 * 仅供 `/batch_kick` 按需读取本群入群日志；Worker 先提交更早到达的
 * 追写缓冲，返回值覆盖请求之前已处理的全部入群事件。
 */
export function readJoinLog({
  chatId,
  since,
  now,
  timeoutMs = LOAD_TIMEOUT_MS,
}: ReadJoinLogParams): Promise<readonly JoinLogRecord[]> {
  return requestFromWritableWorker({
    timeoutMs,
    timeoutLabel: "Join log read timeout",
    action: "read join logs",
    request: (worker: Worker): Promise<readonly JoinLogRecord[]> => requestDiskIO({
      worker,
      channel: joinLogReadRequests,
      timeoutMs,
      buildRequest: (requestId: number): ReadJoinLogRequest => ({ type: "readJoinLog", requestId, chatId, since, now }),
    }),
  });
}

/** 黑白名单与临时广告免检累计 LRU 冷缺失的唯一跨线程批量读取边界。 */
export function readIdentityPolicies(
  ids: readonly number[],
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<IdentityPolicyRawReadResult> {
  return requestFromWritableWorker({
    timeoutMs,
    timeoutLabel: "Identity policy read timeout",
    action: "read identity policies",
    request: (worker: Worker): Promise<IdentityPolicyRawReadResult> => requestDiskIO({
      worker,
      channel: identityPolicyReadRequests,
      timeoutMs,
      buildRequest: (requestId: number): ReadIdentityPoliciesRequest => ({ type: "readIdentityPolicies", requestId, ids }),
    }),
  });
}

/** 群级补扫按稳定主键游标读取一页黑名单；普通成员判定不得调用。 */
export function readBlocklistIdPage(
  afterId: number | null,
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<BlocklistIdPage> {
  return requestFromWritableWorker({
    timeoutMs,
    timeoutLabel: "Blocklist ID read timeout",
    action: "read a blocklist ID page",
    request: (worker: Worker): Promise<BlocklistIdPage> => requestDiskIO({
      worker,
      channel: blocklistIdPageReadRequests,
      timeoutMs,
      buildRequest: (requestId: number): ReadBlocklistIdPageRequest => ({ type: "readBlocklistIdPage", requestId, afterId }),
    }),
  });
}

/**
 * 要求 diskIOWorker 立即把所有 dirty 数据（含待验证增量）全部落盘，
 * 并等待完成，用于进程退出前的最后一刷。等待最长 timeoutMs；resolve 只代表
 * 等待已结束，返回值区分 flushed、timedOut 与 failed。Worker 在这次
 * flush 期间崩溃时，onerror 立即以 failed 结算。
 */
export async function flushDiskIO(timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS): Promise<FlushResult> {
  requirePositiveFinite(timeoutMs, "Disk I/O flush timeout");
  const deadline: number = performance.now() + timeoutMs;
  while (
    diskIORuntime.diagnosticQueue.size > 0 ||
    diskIORuntime.diagnosticDroppedMessages > 0
  ) {
    const remaining: number = deadline - performance.now();
    if (remaining <= 0) return "timedOut";
    const diagnostics: FlushResult = await waitForDiskIODiagnostics(remaining);
    if (diagnostics !== "flushed") return diagnostics;
    // Promise 续体恢复前可能已有新的主线程诊断入队；循环重检，直到与发送
    // flush 处于同一个同步片段，诊断先于 flush 信封。
  }
  const remaining: number = deadline - performance.now();
  if (remaining <= 0) return "timedOut";
  return (await flushWritableScope("all", remaining)).result;
}

/** 当前代际可写时经 beginDiskIOFlush 发起 scope 范围的 flush；没有 Worker 或已不可写时直接按 failed 结算。 */
async function flushWritableScope(scope: DiskFlushScope, timeoutMs: number): Promise<DomainFlushOutcome> {
  requirePositiveFinite(timeoutMs, "Disk I/O flush timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) return { result: "failed" };
  return beginDiskIOFlush(worker, scope, timeoutMs);
}

/**
 * 单个领域的落盘屏障：Worker 只刷这一个领域（共享 SQLite 的各领域共用一个事务，见
 * types/diskIO/messages.ts 的 DiskFlushScope），回执只带该领域自己的失败
 * （见 workers/diskIO/domainFlush.ts）。
 * @returns result 为 "flushed" 表示该领域已 durable，"timedOut"/"failed" 表示没写进去；failedDomains 为本次
 *   回执里的失败领域名，超时或 Worker 崩溃中途结算时没有本次回执，为 undefined。
 */
export function flushDiskIODomain(
  domain: DiskIODomain,
  timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS
): Promise<DomainFlushOutcome> {
  return flushWritableScope(domain, timeoutMs);
}

/**
 * 停机关库：每条 terminateDiskIO 路径（含未捕获异常的紧急释放）都在当前代际已完成恢复握手、
 * 可写且未发出致命信号时发送一次 closeStorage。先把 writable 置假，此后的业务写在源头进恢复
 * 缓冲、随 terminate 丢弃；Worker 按 FIFO 处理完更早的操作后提交残余写、TRUNCATE checkpoint 并关库。
 * checkpoint 被其它读连接挡住只写诊断（残余写已提交，WAL 留在库旁）。
 * @returns 不满足发送条件或回执确认残余写已提交时为 null；回执报残余写未提交，或请求超时、
 *   被拒、回执报错而无法确认时为描述原因的错误。
 */
async function closeDiskIOStorage(): Promise<Error | null> {
  const worker: Worker | null = diskIORuntime.worker;
  if (worker === null || !diskIORuntime.initialized || !diskIORuntime.writable || diskIORuntime.fatalSignaled) return null;
  diskIORuntime.writable = false;
  let outcome: StorageCloseOutcome;
  try {
    outcome = await requestDiskIO({
      worker,
      channel: storageCloseRequests,
      timeoutMs: DISK_IO_STORAGE_CLOSE_TIMEOUT_MS,
      buildRequest: (requestId: number): CloseStorageRequest => ({ type: "closeStorage", requestId }),
    });
  } catch (error: unknown) {
    return new Error(
      "[diskIO] could not confirm that residual storage writes were committed before the database closed.",
      { cause: error }
    );
  }
  if (outcome.checkpointBusy) {
    writeDiskIODiagnostic(
      "[diskIO] WAL checkpoint was blocked by another database reader at shutdown; " +
      "the -wal file stays next to the database and must be backed up with it."
    );
  }
  return outcome.committed
    ? null
    : new Error("[diskIO] residual storage writes were not committed before the database closed.");
}

/**
 * 终止落盘 Worker：先按 closeDiskIOStorage 关库，再清空宿主运行态，拒绝所有待决的 load、
 * 读请求与 flush 并 terminate。关库无法确认残余写已提交时照常终止，随后以该错误 reject，
 * 停机把这一步记为失败（结局 unsettled，见 docs/cn/04-invariants.md）。
 */
export async function terminateDiskIO(): Promise<void> {
  const closeFailure: Error | null = await closeDiskIOStorage();
  resetDiskIOOperations();
  const worker: Worker | null = diskIORuntime.worker;
  diskIORuntime.worker = null;
  diskIORuntime.initialized = false;
  diskIORuntime.writable = false;
  diskIORuntime.diagnosticRecycleWorker = null;
  diskIORuntime.runtimeRecoveryWorker = null;
  clearRuntimeRecoveryTimer();
  diskIORuntime.fatalHandler = undefined;
  diskIORuntime.fatalSignaled = false;
  diskIORuntime.runtimeRecoveryTimeoutMs = LOAD_TIMEOUT_MS;
  diskIORuntime.maxPendingBusinessMessages = DEFAULT_MAX_PENDING_BUSINESS_MESSAGES;
  diskIORuntime.consecutiveDiagnosticWriteFailures = 0;
  diskIORuntime.consecutiveDiagnosticRebuilds = 0;
  diskIORuntime.pendingBusinessMessages.clear();
  resetDiskIODiagnosticChannel();
  diskIOFlushBarrier.settleAll("failed");
  pendingFlushFailedDomains.clear();
  const terminationMessage: string = "Persistence Worker terminated before the request completed.";
  if (pendingLoad.timer !== null) clearTimeout(pendingLoad.timer);
  pendingLoad.timer = null;
  pendingLoad.resolve = null;
  pendingLoad.reject?.(new Error(terminationMessage));
  pendingLoad.reject = null;
  rejectAllPendingDiskIORequests((): string => terminationMessage);
  if (worker !== null) {
    try {
      worker.terminate();
    } catch (error: unknown) {
      throw toErrorOr(error, "Persistence Worker termination failed.");
    }
  }
  if (closeFailure !== null) throw closeFailure;
}
