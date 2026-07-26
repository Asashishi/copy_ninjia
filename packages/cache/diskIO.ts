import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import { WORKER_MAX_RESTARTS, WORKER_RESTART_WINDOW_MS } from "../consts/workerSupervisor";
import { createFlushBarrier } from "../libs/flushBarrier";
import { LinkedQueue } from "../libs/linkedQueue";
import { createRestartThrottle } from "../libs/restartThrottle";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
  DiskBusinessMessage,
  DiskIODomain,
  LoadedReply,
  VerificationPersistedReply,
} from "../types/diskIO";
import type { LuckReceiptSecret } from "../types/diskIO/storage";

/** 磁盘 IO 宿主（packages/infra/diskIO.ts）的内存状态：主线程侧的 flush/load 回执路由。 */

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
  respawnListeners: (() => void)[];
  verificationPersistedListeners: ((reply: VerificationPersistedReply) => void)[];
  aiMemoryDeletedPersistedListeners: ((reply: AiMemoryDeletedPersistedReply) => void)[];
  aiMemoryPersistedListeners: ((reply: AiMemoryPersistedReply) => void)[];
  nextLuckSecretRequestId: number;
  /**
   * 最近一次 flush 回执里没能落盘的领域。仅供日志与诊断展示；业务成功判断
   * 必须使用 pendingFlushFailedDomains 中与请求 ID 绑定的回执。
   */
  lastFlushFailedDomains: readonly DiskIODomain[];
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
  nextLuckSecretRequestId: 1,
  lastFlushFailedDomains: [],
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
