/** 进程停机排空、轮询与落盘的统一时间预算。 */

import type { FlushTimeouts } from "../types/lifecycle";

/** 等待 grammY runner 中在途 update 处理完毕的最长时间与轮询间隔。 */
export const RUNNER_DRAIN_TIMEOUT_MS: number = 5_000;
/** 等待 runner 归零时的轮询间隔。 */
export const RUNNER_DRAIN_POLL_INTERVAL_MS: number = 100;

/** 正常停机时各持久化 owner 的独立 flush 预算。 */
export const AI_MEMORY_FLUSH_TIMEOUT_MS: number = 2_000;
/** 正常停机等待 Disk I/O Worker flush 的预算。 */
export const DISK_IO_FLUSH_TIMEOUT_MS: number = 3_000;
/** 正常停机等待 state 主/LKG 写入的预算。 */
export const STATE_FLUSH_TIMEOUT_MS: number = 3_000;
/** 正常停机等待头像、反应与翻译 owner 的预算。 */
export const BACKGROUND_MAINTENANCE_TIMEOUT_MS: number = 3_000;

/** 单次 Google Translation RPC 的上限，避免在途翻译无限阻塞停机。 */
export const TRANSLATE_REQUEST_TIMEOUT_MS: number = 2_500;

/** 未捕获异常路径的尽力落盘预算；避免故障进程在清理阶段久留。 */
export const EMERGENCY_FLUSH_TIMEOUT_MS: number = 1_000;
/**
 * 普通关停已在途时发生致命异常，复用该关停 Promise 所允许的绝对最长时间。
 * 该截止独立于各 owner 的 flush 预算，属于生命周期模块的最终强制退出边界。
 */
export const EMERGENCY_REUSED_DISPOSE_DEADLINE_MS: number = 15_000;

/** 正常停机与异常退出路径各自采用一组完整、不可拆散的时间预算。 */
export const NORMAL_FLUSH_TIMEOUTS: Readonly<FlushTimeouts> = Object.freeze({
  aiMemoryMs: AI_MEMORY_FLUSH_TIMEOUT_MS,
  diskIOMs: DISK_IO_FLUSH_TIMEOUT_MS,
  stateMs: STATE_FLUSH_TIMEOUT_MS,
  maintenanceMs: BACKGROUND_MAINTENANCE_TIMEOUT_MS,
});

/** 未捕获异常路径采用的完整、短预算组合。 */
export const EMERGENCY_FLUSH_TIMEOUTS: Readonly<FlushTimeouts> = Object.freeze({
  aiMemoryMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  diskIOMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  stateMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  maintenanceMs: 0,
});
