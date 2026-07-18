/** 消息自动流水线（src/auto）的内存状态。 */

/**
 * 记录各用户上一次触发随机 AI 回复（随机插话/媒体评价）的时刻，以 chatId + 用户 id
 * 拼接作为 key。条目由 src/auto/message.ts 的 tryClaimUserReplyTrigger 在
 * 冷却期满后自动清理。
 */
export const userReplyTriggerTimes: Map<string, number> = new Map();
