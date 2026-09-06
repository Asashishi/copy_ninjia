import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../../consts/workerSupervisor";
import { createFlushBarrier } from "../../libs/flushBarrier";
import { LinkedQueue } from "../../libs/linkedQueue";
import { createRestartThrottle } from "../../libs/restartThrottle";
import { AcknowledgedBatchQueue } from "../../libs/acknowledgedBatchQueue";
import { DISK_OPERATION_CONTROL_RESERVE, DISK_BUSINESS_BATCH_MAX_MESSAGES, DISK_OPERATION_MAX_RETAINED_BYTES } from "../../consts/diskIO/business";
import {
  DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES,
  DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES,
  DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES,
} from "../../consts/diskIO/diagnostics";
import type {
  DiskBusinessMessage,
  DiskIORespawnRegistration,
  DiskDiagnosticMessage,
  DiskIOOperationMessage,
} from "../../types/diskIO/messages";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
  DiskIODomain,
  LoadedReply,
  LuckAppendStalledReply,
  IdentityStoragePersistedReply,
  MidnightMaintenanceReply,
  VerificationPersistedReply,
} from "../../types/diskIO/replies";
import type { JoinLogRecord, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { IdentityPolicyRawReadResult } from "../../types/identityStorage";
import type { BlocklistIdPage } from "../../types/identityStorage";

/**
 * 磁盘 IO 宿主（packages/infra/diskIO.ts）的内存状态：主线程侧的 flush/load 回执路由。
 *
 * 本目录里唯一一个会被别的线程一并加载的模块，也是线程归属检查里唯一一条豁免
 * （见 scripts/checkProjectConventions.ts）：infra/logger.ts 静态 import
 * infra/diskIO.ts 取 relayLogMessage，而每条线程都要能记日志。Worker isolate
 * 里这份状态**恒为初始值**——只有主线程会 initDiskIO 填 worker 句柄，Worker 侧的
 * error 日志走 postMessage 信封回主线程再转投（见 infra/logger.ts 模块头注），
 * 一次也不会读写这里。所有权因此仍然只在主线程，不是 perThread/。
 */

/**
 * loadPersistedData 当前挂起的启动恢复回调。运行时重建另由 infra/diskIO.ts
 * 的显式 recovery Worker 状态接管，成功前始终不可写。
 */
export const pendingLoad: {
  resolve: ((reply: LoadedReply) => void) | null;
  reject: ((error: Error) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
} = { resolve: null, reject: null, timer: null };

/** 一条在途 main -> diskIO 请求的等待者。 */
export interface PendingDiskIORequest<TResult> {
  resolve: (value: TResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 一条 main -> diskIO 的 request/reply 通道：等待表、发号器与两句领域文案。
 *
 * 运势密钥、入群日志、身份策略、黑名单主键四个领域各声明一个通道对象；统一
 * 请求、回执路由与 Worker 代际失效结算按通道表工作。
 */
export interface DiskIORequestChannel<TResult> {
  /** 超时与拒收文案里的领域名，例如 `identity policy read`。 */
  readonly label: string;
  /** Worker 回执缺少载荷时的错误文案；各领域点名自己缺的东西。 */
  readonly missingPayload: string;
  /** 逐请求等待表；只由 infra/diskIO/host.ts 填充与结算。 */
  readonly pending: Map<number, PendingDiskIORequest<TResult>>;
  /** 本代际发号器；terminateDiskIO 归零。 */
  nextRequestId: number;
}

function createDiskIORequestChannel<TResult>(
  label: string,
  missingPayload: string
): DiskIORequestChannel<TResult> {
  return { label, missingPayload, pending: new Map(), nextRequestId: 1 };
}

/** ensureLuckReceiptSecret 的请求通道。 */
export const luckSecretRequests: DiskIORequestChannel<LuckReceiptSecret> =
  createDiskIORequestChannel("luck receipt secret", "Disk I/O Worker returned no luck receipt secret.");

/** `/batch_kick` 按需读取入群日志的请求通道。 */
export const joinLogReadRequests: DiskIORequestChannel<readonly JoinLogRecord[]> =
  createDiskIORequestChannel("join log read", "Disk I/O Worker returned no join records.");

/** 黑白名单 LRU 冷缺失的请求通道。 */
export const identityPolicyReadRequests: DiskIORequestChannel<IdentityPolicyRawReadResult> =
  createDiskIORequestChannel("identity policy read", "Disk I/O Worker returned no identity policy rows.");

/** 群级补扫有界黑名单主键页的请求通道。 */
export const blocklistIdPageReadRequests: DiskIORequestChannel<BlocklistIdPage> =
  createDiskIORequestChannel("blocklist ID page read", "Disk I/O Worker returned no blocklist ID page.");

/**
 * 全部请求通道。Worker 代际失效、恢复失败与 terminate 都按表结算所有等待者。
 * 元素的 TResult 各不相同，统一失败路径只需要 reject 与 timer，故按最小结构擦除。
 */
export const DISK_IO_REQUEST_CHANNELS: readonly DiskIORequestChannel<never>[] = [
  luckSecretRequests,
  joinLogReadRequests,
  identityPolicyReadRequests,
  blocklistIdPageReadRequests,
] as readonly DiskIORequestChannel<never>[];

/**
 * Worker 明确回复为部分失败、且正在等待调用方消费的 flush 回执。
 * host 只在对应 barrier 仍在途时填充，infra/diskIO.ts 在同一次请求恢复后立即删除；
 * 传输失败、超时、Worker 崩溃不会产生条目，因而不能被误判成某领域成功。
 */
export const pendingFlushFailedDomains: Map<number, readonly DiskIODomain[]> = new Map();

interface DiskIORuntime {
  worker: Worker | null;
  initialized: boolean;
  writable: boolean;
  diagnosticRecycleWorker: Worker | null;
  runtimeRecoveryWorker: Worker | null;
  runtimeRecoveryTimer: ReturnType<typeof setTimeout> | null;
  runtimeRecoveryTimeoutMs: number;
  maxPendingBusinessMessages: number;
  fatalHandler: ((error: Error) => void) | undefined;
  fatalSignaled: boolean;
  pendingBusinessMessages: LinkedQueue<DiskBusinessMessage>;
  pendingBusinessBytes: number;
  operationQueue: AcknowledgedBatchQueue<DiskIOOperationMessage>;
  operationTimer: ReturnType<typeof setTimeout> | null;
  diagnosticQueue: AcknowledgedBatchQueue<DiskDiagnosticMessage>;
  diagnosticDroppedMessages: number;
  diagnosticDroppedSerializedBytes: number;
  diagnosticRetryTimer: ReturnType<typeof setTimeout> | null;
  consecutiveDiagnosticWriteFailures: number;
  consecutiveDiagnosticRebuilds: number;
  diagnosticDrainWaiters: Set<{
    resolve: (result: "flushed" | "timedOut" | "failed") => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
  respawnListeners: DiskIORespawnRegistration[];
  midnightMaintenanceListeners: ((reply: MidnightMaintenanceReply) => void)[];
  verificationPersistedListeners: ((reply: VerificationPersistedReply) => void)[];
  aiMemoryDeletedPersistedListeners: ((reply: AiMemoryDeletedPersistedReply) => void)[];
  aiMemoryPersistedListeners: ((reply: AiMemoryPersistedReply) => void)[];
  luckAppendStalledListeners: ((reply: LuckAppendStalledReply) => void)[];
  identityStoragePersistedListeners: ((reply: IdentityStoragePersistedReply) => void)[];
  giveUpListeners: (() => void)[];
}

/**
 * 主线程 Disk I/O Worker 的完整运行态。initDiskIO 填充 Worker/配置，恢复
 * 窗口暂存有硬顶的业务消息；terminateDiskIO 结算等待、清 timer 并恢复默认值。
 * Worker 崩溃后保留监听器并从主线程镜像重建，业务队列容量由配置硬顶约束。
 * midnightMaintenanceListeners 仅模块初始化登记，容量由主线程维护领域数约束；
 * Worker 重建保留监听器且不重放午夜通知，进程退出时随 owner 释放。
 * diagnosticQueue 由 relayLogMessage/postDiskIODiagnostic 填充、DiskIO ACK 排空；
 * 单批在途并保留到 ACK，Worker 崩溃后原批重发。总消息数与 JSON 载荷字节均有
 * 硬顶；越界项只累加两个标量，队列重新有空间后追加一条汇总日志。terminate 时
 * 队列与丢弃计数一起清空。
 * operationQueue 保存业务与读取的单批在途 FIFO；消费 ACK 后释放，崩溃时业务
 * 转交恢复 FIFO，查询由宿主拒绝。两份 FIFO 共用条数与字节上限，单批 timer
 * 超时通知 fatal。terminate 清理全部队列和 timer，Worker 重建按原序重放。
 * diagnosticDrainWaiters 只由并发的进程级 flush 填充，ACK、超时或 terminate
 * 结算清理，容量受同时在途的 shutdown flush 数约束；Worker 重建期间原样等待重放。
 */
export const diskIORuntime: DiskIORuntime = {
  worker: null,
  initialized: false,
  writable: false,
  diagnosticRecycleWorker: null,
  runtimeRecoveryWorker: null,
  runtimeRecoveryTimer: null,
  runtimeRecoveryTimeoutMs: LOAD_TIMEOUT_MS,
  maxPendingBusinessMessages: DEFAULT_MAX_PENDING_BUSINESS_MESSAGES,
  fatalHandler: undefined,
  fatalSignaled: false,
  pendingBusinessMessages: new LinkedQueue<DiskBusinessMessage>(),
  pendingBusinessBytes: 0,
  operationQueue: new AcknowledgedBatchQueue<DiskIOOperationMessage>({
    maxBatchMessages: DISK_BUSINESS_BATCH_MAX_MESSAGES,
    maxMessages: DEFAULT_MAX_PENDING_BUSINESS_MESSAGES + DISK_OPERATION_CONTROL_RESERVE,
    maxCost: DISK_OPERATION_MAX_RETAINED_BYTES,
  }),
  operationTimer: null,
  diagnosticQueue: new AcknowledgedBatchQueue<DiskDiagnosticMessage>({
    maxBatchMessages: DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES,
    maxMessages: DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES,
    maxCost: DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES,
  }),
  diagnosticDroppedMessages: 0,
  diagnosticDroppedSerializedBytes: 0,
  diagnosticRetryTimer: null,
  consecutiveDiagnosticWriteFailures: 0,
  consecutiveDiagnosticRebuilds: 0,
  diagnosticDrainWaiters: new Set(),
  respawnListeners: [],
  midnightMaintenanceListeners: [],
  verificationPersistedListeners: [],
  aiMemoryDeletedPersistedListeners: [],
  aiMemoryPersistedListeners: [],
  luckAppendStalledListeners: [],
  identityStoragePersistedListeners: [],
  giveUpListeners: [],
};

/**
 * Disk I/O Worker 的滑动窗口重启节流器。进程启动时创建，Worker 重建时
 * 累积时间戳，超过窗口后触发 fatal；进程重启后从空窗口重建，容量有硬顶。
 */
export const diskIORestartThrottle: ReturnType<typeof createRestartThrottle> =
  createRestartThrottle(WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS);

/**
 * Disk I/O flush 的在途 barrier。flush 请求时填充，回执、超时、崩溃或
 * terminate 时结算清空；进程重启后从空表重建，容量受在途 flush 数约束。
 */
export const diskIOFlushBarrier: ReturnType<typeof createFlushBarrier> =
  createFlushBarrier({ timeoutMs: DISK_IO_FLUSH_TIMEOUT_MS });
