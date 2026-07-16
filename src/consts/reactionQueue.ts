/** 反应同步队列（src/copy/reactionQueue.ts）的调参常量。 */

/**
 * 单个任务遇到 429 限流时的最大尝试次数（含首次，即最多重试 MAX_ATTEMPTS-1
 * 次），防止极端限流下队列被一个任务卡死。
 */
export const MAX_ATTEMPTS: number = 3;
/** Telegram 429 响应缺失 retry_after 字段时的兜底等待秒数。 */
export const DEFAULT_RETRY_AFTER_SECONDS: number = 3;
