import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../../consts/lifecycle";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../../consts/workerSupervisor";
import { createFlushBarrier } from "../../libs/flushBarrier";
import { LinkedQueue } from "../../libs/linkedQueue";
import { createRestartThrottle } from "../../libs/restartThrottle";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
  DiskBusinessMessage,
  DiskIODomain,
  DiskIORespawnRegistration,
  LoadedReply,
  LuckAppendStalledReply,
  VerificationPersistedReply,
} from "../../types/diskIO";
import type { JoinLogRecord, LuckReceiptSecret } from "../../types/diskIO/storage";

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

/** ensureLuckReceiptSecret 的逐请求等待表。 */
export const pendingLuckSecrets: Map<number, {
  resolve: (secret: LuckReceiptSecret) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}> = new Map();

/** `/batch_kick` 按需读取入群日志的逐请求等待表。 */
export const pendingJoinLogReads: Map<number, {
  resolve: (records: readonly JoinLogRecord[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}> = new Map();

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
  runtimeRecoveryWorker: Worker | null;
  runtimeRecoveryTimer: ReturnType<typeof setTimeout> | null;
  runtimeRecoveryTimeoutMs: number;
  maxPendingBusinessMessages: number;
  fatalHandler: ((error: Error) => void) | undefined;
  fatalSignaled: boolean;
  pendingBusinessMessages: LinkedQueue<DiskBusinessMessage>;
  respawnListeners: DiskIORespawnRegistration[];
  verificationPersistedListeners: ((reply: VerificationPersistedReply) => void)[];
  aiMemoryDeletedPersistedListeners: ((reply: AiMemoryDeletedPersistedReply) => void)[];
  aiMemoryPersistedListeners: ((reply: AiMemoryPersistedReply) => void)[];
  luckAppendStalledListeners: ((reply: LuckAppendStalledReply) => void)[];
  nextLuckSecretRequestId: number;
  nextJoinLogReadRequestId: number;
}

/**
 * 主线程 Disk I/O Worker 的完整运行态。initDiskIO 填充 Worker/配置，恢复
 * 窗口暂存有硬顶的业务消息；terminateDiskIO 结算等待、清 timer 并恢复默认值。
 * Worker 崩溃后保留监听器并从主线程镜像重建，队列容量由配置硬顶约束。
 */
export const diskIORuntime: DiskIORuntime = {
  worker: null,
  initialized: false,
  writable: false,
  runtimeRecoveryWorker: null,
  runtimeRecoveryTimer: null,
  runtimeRecoveryTimeoutMs: LOAD_TIMEOUT_MS,
  maxPendingBusinessMessages: DEFAULT_MAX_PENDING_BUSINESS_MESSAGES,
  fatalHandler: undefined,
  fatalSignaled: false,
  pendingBusinessMessages: new LinkedQueue<DiskBusinessMessage>(),
  respawnListeners: [],
  verificationPersistedListeners: [],
  aiMemoryDeletedPersistedListeners: [],
  aiMemoryPersistedListeners: [],
  luckAppendStalledListeners: [],
  nextLuckSecretRequestId: 1,
  nextJoinLogReadRequestId: 1,
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
