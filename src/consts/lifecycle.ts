/** 进程停机排空、轮询与落盘的统一时间预算。 */

export type FlushResult = "flushed" | "timedOut" | "failed";

export interface FlushTimeouts {
  aiMemoryMs: number;
  diskIOMs: number;
  stateMs: number;
  maintenanceMs: number;
}

/** 等待 grammY runner 中在途 update 处理完毕的最长时间与轮询间隔。 */
export const RUNNER_DRAIN_TIMEOUT_MS: number = 5_000;
export const RUNNER_DRAIN_POLL_INTERVAL_MS: number = 100;

/** 正常停机时各持久化 owner 的独立 flush 预算。 */
export const AI_MEMORY_FLUSH_TIMEOUT_MS: number = 2_000;
export const DISK_IO_FLUSH_TIMEOUT_MS: number = 3_000;
export const STATE_FLUSH_TIMEOUT_MS: number = 3_000;
export const BACKGROUND_MAINTENANCE_TIMEOUT_MS: number = 3_000;

/** 单次 Google Translation RPC 的上限，避免在途翻译无限阻塞停机。 */
export const TRANSLATE_REQUEST_TIMEOUT_MS: number = 2_500;

/** 未捕获异常路径的尽力落盘预算；避免故障进程在清理阶段久留。 */
export const EMERGENCY_FLUSH_TIMEOUT_MS: number = 1_000;

/** 正常停机与异常退出路径各自采用一组完整、不可拆散的时间预算。 */
export const NORMAL_FLUSH_TIMEOUTS: FlushTimeouts = {
  aiMemoryMs: AI_MEMORY_FLUSH_TIMEOUT_MS,
  diskIOMs: DISK_IO_FLUSH_TIMEOUT_MS,
  stateMs: STATE_FLUSH_TIMEOUT_MS,
  maintenanceMs: BACKGROUND_MAINTENANCE_TIMEOUT_MS,
};

export const EMERGENCY_FLUSH_TIMEOUTS: FlushTimeouts = {
  aiMemoryMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  diskIOMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  stateMs: EMERGENCY_FLUSH_TIMEOUT_MS,
  maintenanceMs: 0,
};
