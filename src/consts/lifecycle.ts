/** 进程停机排空、轮询与落盘的统一时间预算。 */

/** 等待 grammY runner 中在途 update 处理完毕的最长时间与轮询间隔。 */
export const RUNNER_DRAIN_TIMEOUT_MS: number = 5_000;
export const RUNNER_DRAIN_POLL_INTERVAL_MS: number = 100;

/** 正常停机时各持久化 owner 的独立 flush 预算。 */
export const AI_MEMORY_FLUSH_TIMEOUT_MS: number = 2_000;
export const DISK_IO_FLUSH_TIMEOUT_MS: number = 3_000;
export const STATE_FLUSH_TIMEOUT_MS: number = 3_000;

/** 未捕获异常路径的尽力落盘预算；避免故障进程在清理阶段久留。 */
export const EMERGENCY_FLUSH_TIMEOUT_MS: number = 1_000;
