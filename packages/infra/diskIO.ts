/**
 * 进程唯一的共享数据 Disk I/O Worker 宿主（主线程侧）：统一承载日志、AI/贴纸快照、
 * 每日运势、待验证当日增量 JSON、群状态与 /block 黑名单——由 diskIOWorker 在单一 Worker
 * 线程里串行执行，避免多个业务 Worker 并发写坏共享文件。state.json 只保留 global，
 * 由主线程经 infra/storage/stateStore.ts 门面交给 statePersistence.ts 独立异步读写与 flush。
 *
 * Worker 拥有权、flush/load 握手与对外投递语义收在本文件；Worker 创建、
 * 回执路由与崩溃自愈的重启节流在 infra/diskIO/host.ts。
 * infra/logger.ts 只是调用方之一（error 日志经 relayLogMessage 投递）。
 * aiChat/workerBridge.ts、commands/luckChallenge/cache.ts、antiRaid/workerBridge.ts 与
 * infra/blocklist/ 经 postDiskIO 投递。
 *
 * 本模块自身的错误一律 console.error（由进程控制台日志兜底）——它就是落盘终点，
 * 不能再指望被自己转发的日志线程落盘自己的错误，否则是一场递归。这也是
 * 本模块不复用 infra/supervisedWorker.ts 通用骨架（其 onerror 走 logger.error）
 * 的原因，需要一份独立的、只用 console 的自愈逻辑。
 * @see ../../docs/cn/04-invariants.md
 */

import {
  DISK_IO_REQUEST_CHANNELS,
  diskIOFlushBarrier,
  diskIORuntime,
  pendingFlushFailedDomains,
  pendingLoad,
} from "../cache/main/diskIO";
import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import {
  clearRuntimeRecoveryTimer,
  createDiskIOWorker,
  rejectPendingDiskIORequests,
  requestJoinLogFromWorker,
  requestIdentityPoliciesFromWorker,
  requestBlocklistIdPageFromWorker,
  requestLuckSecretFromWorker,
  stopWorkerAfterLoadFailure,
} from "./diskIO/host";
import {
  enqueueDiskIODiagnostic,
  resetDiskIODiagnosticChannel,
  waitForDiskIODiagnostics,
} from "./diskIO/diagnosticChannel";
import { safePostDiskIO } from "./diskIO/transport";
import { getStickerConfig } from "../config/stickers";
export {
  onAiMemoryDeletedPersisted,
  onAiMemoryPersisted,
  onDiskIOGiveUp,
  onDiskIORespawn,
  onIdentityStoragePersisted,
  onLuckAppendStalled,
  onVerificationPersisted,
} from "./diskIO/observers";
import type { FlushResult } from "../types/lifecycle";
import type {
  DiskBusinessMessage,
  DiskFlushRequest,
  LoadRequest,
  AdSampleDiskMessage,
  LogMessage,
} from "../types/diskIO/messages";
import type {
  DiskIODomain,
  DomainFlushOutcome,
  LoadedData,
  LoadedReply,
} from "../types/diskIO/replies";
import type {
  JoinLogRecord,
  LuckReceiptSecret,
} from "../types/diskIO/storage";
import type { IdentityPolicyRawReadResult } from "../types/identityStorage";
import type { BlocklistIdPage } from "../types/identityStorage";

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
// 创建线程：否则竞争单实例锁失败的第二进程仍会触达共享数据。Worker 线程里
// 永远不初始化本宿主，只使用 logger.ts 的转发模式。
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
  diskIORuntime.consecutiveDiagnosticWriteFailures = 0;
  diskIORuntime.consecutiveDiagnosticRebuilds = 0;
  diskIORuntime.diagnosticRecycleWorker = null;
  diskIORuntime.writable = false;
  diskIORuntime.worker = createDiskIOWorker();
  diskIORuntime.initialized = true;
}

/** 供入口生命周期守卫和无副作用 import 测试查询，不代表 Worker 当前可用。 */
export function isDiskIOInitialized(): boolean {
  return diskIORuntime.initialized;
}

/**
 * 把其它 Worker 线程转发来的 error 日志交给主线程有界 FIFO（logger.ts 的转发模式）。
 * DiskIO Worker 不可写、崩溃或同步拒收时延后重投；容量越界时释放原消息引用并
 * 记入后续汇总，因此本函数仍返回已接管，让来源 Worker 可以释放原批。
 */
export function relayLogMessage(message: LogMessage): boolean {
  // 进程尚未取得单实例锁、也未初始化唯一 DiskIO owner 时保持旧边界：只写
  // journal，不建立可能永远等不到消费者的进程级积压。业务 Worker 只会在
  // DiskIO 初始化完成后启动，因此运行期转发不经过这个分支。
  if (!diskIORuntime.initialized) return false;
  return enqueueDiskIODiagnostic({ type: "log", ...message });
}

/**
 * 主线程 -> diskIOWorker：排队一条不进入业务恢复缓冲的旁路诊断（目前只有广告命中样本）。
 *
 * 与 postDiskIO 的差别是它进入独立有界 FIFO，不占 pendingBusinessMessages 的
 * 恢复预算，也绝不触发业务 fatal；Worker 代际失败后原批重发，容量越界则记入
 * 一条后续汇总。样本文件自身仍是
 * best effort 的人工素材，写盘失败不会拖垮权威状态，见 diskIO/adSampleFile.ts。
 * @returns 已由有界诊断通道接管；调用方无需自行重试。
 */
export function postDiskIODiagnostic(message: AdSampleDiskMessage): boolean {
  if (!diskIORuntime.initialized) return false;
  return enqueueDiskIODiagnostic(message);
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
 * Worker 当前是否处在「不可写、但仍在受理」的恢复握手期。
 *
 * 这段窗口里 postDiskIO 返回的 true 与平时不是一个意思：消息没有发给 Worker，
 * 而是进了有硬顶的 FIFO（pendingBusinessMessages），等 activateDiskIOWorker
 * 握手完成后原序重放；重放失败会走 stopWorkerAfterLoadFailure 的统一 fatal。
 * 同一窗口里 requestDiskIOFlush 直接短路成 `"failed"`——那是「此刻没人能刷盘」，
 * 不是「写坏了」。需要 durable 屏障的调用方（infra/joinLog.ts）必须能把两者
 * 分开，否则一次 Worker 崩溃自愈就会被放大成整进程退出。
 * @returns worker 还在但不可写为 true；worker 已经没了（terminate 后）为 false。
 */
export function isDiskIOBuffering(): boolean {
  return diskIORuntime.worker !== null && !diskIORuntime.writable;
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
        pendingBlockedRemovals: reply.pendingBlockedRemovals,
        blocklistEntryCount: reply.blocklistEntryCount,
        whitelistEntryCount: reply.whitelistEntryCount,
        chatStates: reply.chatStates,
        chatQa: reply.chatQa,
      });
    };
    const request: LoadRequest = {
      type: "load",
      stickerPacks: getStickerConfig().packs,
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

/** 黑白名单与临时白名单累计 LRU 冷缺失的唯一跨线程批量读取边界。 */
export function readIdentityPolicies(
  ids: readonly number[],
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<IdentityPolicyRawReadResult> {
  requirePositiveFinite(timeoutMs, "Identity policy read timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) {
    return Promise.reject(new Error("Persistence Worker is unavailable; cannot read identity policies."));
  }
  return requestIdentityPoliciesFromWorker({ worker, ids, timeoutMs });
}

/** 群级补扫按稳定主键游标读取一页黑名单；普通成员判定不得调用。 */
export function readBlocklistIdPage(
  afterId: number | null,
  timeoutMs: number = LOAD_TIMEOUT_MS
): Promise<BlocklistIdPage> {
  requirePositiveFinite(timeoutMs, "Blocklist ID read timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) {
    return Promise.reject(new Error("Persistence Worker is unavailable; cannot read a blocklist ID page."));
  }
  return requestBlocklistIdPageFromWorker(worker, afterId, timeoutMs);
}

/**
 * 要求 diskIOWorker 立即把所有 dirty 数据（含待验证增量）全部落盘，
 * 并等待完成。用于进程退出前的最后一刷。带超时兜底：
 * Worker 异常时停机流程最多被拖住 timeoutMs，不会挂死。resolve 只代表
 * "等待已结束"；返回值明确区分成功、超时与失败。Worker 若恰好在这次
 * flush 期间崩溃，onerror 会立即以 failed 结算并记录数据未落盘。
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
    // Promise 续体恢复前可能已有另一条主线程诊断入队；重新检查到真正发送
    // flush 的同一个同步片段，不能让它落到 flush 信封后面。
  }
  const remaining: number = deadline - performance.now();
  if (remaining <= 0) return "timedOut";
  return (await requestDiskIOFlush(remaining)).result;
}

async function requestDiskIOFlush(
  timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS
): Promise<DomainFlushOutcome> {
  requirePositiveFinite(timeoutMs, "Disk I/O flush timeout");
  const worker: Worker | null = diskIORuntime.worker;
  if (!worker || !diskIORuntime.writable) return { result: "failed" };
  let flushId: number | null = null;
  const result: FlushResult = await diskIOFlushBarrier.begin((id: number): boolean => {
    flushId = id;
    const request: DiskFlushRequest = { type: "flush", flushId: id, scope: "all" };
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
 * 就是十二个领域一起刷），但把「无关领域失败」判成成功。
 *
 * 存在的理由：`flushAll` 是十二个领域的合取，任何一个失败（典型是某群
 * `memory/ai/<chat>.json` 部署后属主不对）都会让 /block 报「小本本没能写进
 * 硬盘」，把运维引向一个其实没坏的文件。
 * @returns 该领域已 durable 为 "flushed"；"timedOut"/"failed" 表示没写进去。
 */
export async function flushDiskIODomain(
  domain: DiskIODomain,
  timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS
): Promise<FlushResult> {
  // 不经 flushDiskIODomainOutcome 转一手：这条是入群事实的 durable 屏障
  // （infra/joinLog.ts），多套一层 async 就多一个 promise 和一个只为取 result
  // 而生的临时对象。共用的只是下面那个同步判定。
  return narrowFlushResultToDomain(await requestDiskIOFlush(timeoutMs), domain);
}

/**
 * 同上，但把**本次请求**回执里的失败领域名一并带出，供调用方点名真正坏掉的
 * 文件（Worker 侧的写盘错误按设计只有 console.error，不点名就没有一条进得了
 * logs/）。超时或 Worker 崩溃中途结算时没有本次回执，failedDomains 保持
 * undefined——那种情况下任何领域名都只是别的 flush 留下的旧值。
 */
export async function flushDiskIODomainOutcome(
  domain: DiskIODomain,
  timeoutMs: number = DISK_IO_FLUSH_TIMEOUT_MS
): Promise<DomainFlushOutcome> {
  const outcome: DomainFlushOutcome = await requestDiskIOFlush(timeoutMs);
  const result: FlushResult = narrowFlushResultToDomain(outcome, domain);
  return result === "failed" && outcome.failedDomains !== undefined
    ? { result, failedDomains: outcome.failedDomains }
    : { result };
}

/** 把整轮 flush 的结局收窄到单个领域：无关领域失败按成功计。 */
function narrowFlushResultToDomain(
  outcome: DomainFlushOutcome,
  domain: DiskIODomain
): FlushResult {
  if (outcome.result !== "failed") return outcome.result;
  if (outcome.failedDomains === undefined) return "failed";
  return outcome.failedDomains.includes(domain) ? "failed" : "flushed";
}

/** 终止落盘 Worker；返回后旧实例不可能再 rename/append 共享文件。 */
export function terminateDiskIO(): Promise<void> {
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
  for (const channel of DISK_IO_REQUEST_CHANNELS) channel.nextRequestId = 1;
  diskIOFlushBarrier.settleAll("failed");
  pendingFlushFailedDomains.clear();
  const terminationError: Error = new Error("Persistence Worker terminated before the request completed.");
  if (pendingLoad.timer !== null) clearTimeout(pendingLoad.timer);
  pendingLoad.timer = null;
  pendingLoad.resolve = null;
  pendingLoad.reject?.(terminationError);
  pendingLoad.reject = null;
  for (const channel of DISK_IO_REQUEST_CHANNELS) {
    rejectPendingDiskIORequests(channel, terminationError);
  }
  if (worker === null) return Promise.resolve();
  try {
    worker.terminate();
    return Promise.resolve();
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error("Persistence Worker termination failed."));
  }
}
