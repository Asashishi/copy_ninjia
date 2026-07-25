/**
 * 进程唯一的共享数据 Disk I/O Worker 宿主（主线程侧）：统一承载日志、AI/贴纸快照、
 * 每日运势与待验证当日增量 JSON——由 diskIOWorker 在单一 Worker 线程里
 * 串行执行，避免多个业务 Worker 并发写坏共享文件。state.json 是明确例外，
 * 由主线程的 infra/storage/stateStore.ts 独立异步读写与 flush。
 *
 * Worker 拥有权、flush/load 握手与对外投递语义收在本文件；Worker 创建、
 * 回执路由与崩溃自愈的重启节流在 infra/diskIO/host.ts。
 * infra/logger.ts 只是调用方之一（error 日志经 relayLogMessage 投递）。
 * aiChat/index.ts、commands/luckChallenge/cache.ts 与 antiRaid/index.ts 经 postDiskIO 投递。
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
  pendingLoad,
  pendingLuckSecrets,
} from "../cache/diskIO";
import { DEFAULT_MAX_PENDING_BUSINESS_MESSAGES, LOAD_TIMEOUT_MS } from "../consts/diskIO/common";
import { DISK_IO_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import {
  clearRuntimeRecoveryTimer,
  createDiskIOWorker,
  safePostDiskIO,
  stopWorkerAfterLoadFailure,
} from "./diskIO/host";
import type { FlushResult } from "../types/lifecycle";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
  DiskBusinessMessage,
  DiskFlushRequest,
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
  return new Promise((resolve: (value: LuckReceiptSecret | PromiseLike<LuckReceiptSecret>) => void, reject: (reason?: unknown) => void): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
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
  return diskIOFlushBarrier.begin((id: number): boolean => {
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
  if (worker === null) return Promise.resolve();
  try {
    worker.terminate();
    return Promise.resolve();
  } catch (error: unknown) {
    return Promise.reject(error instanceof Error ? error : new Error("Persistence Worker termination failed."));
  }
}
