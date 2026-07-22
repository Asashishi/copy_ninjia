/** 反应同步队列（src/copy/reactionQueue.ts）的调参常量。 */

/**
 * 单个任务遇到 429 限流时的最大尝试次数（含首次，即最多重试 MAX_ATTEMPTS-1
 * 次），防止极端限流下队列被一个任务卡死。
 */
export const MAX_ATTEMPTS: number = 3;
/** 单群最多积压的不同消息反应任务；429/网络停顿时防止队列无限持有更新。 */
export const MAX_PENDING_TASKS_PER_CHAT: number = 500;
/** Telegram 429 响应缺失 retry_after 字段时的兜底等待秒数。 */
export const DEFAULT_RETRY_AFTER_SECONDS: number = 3;
/** 防御异常 retry_after 制造超长 referenced timer；与 Telegram 客户端重试上限一致。 */
export const MAX_RETRY_AFTER_SECONDS: number = 5;
