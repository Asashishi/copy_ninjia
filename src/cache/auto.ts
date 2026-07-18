/** 消息自动流水线（src/auto）的内存状态。 */

/**
 * 记录各用户上一次触发 AI 自动回复（任意路径：回复机器人/@机器人/拿媒体
 * 叫机器人的必回路径，以及随机插话/媒体评价）的时刻，以 chatId + 用户 id
 * 拼接作为 key。条目由 src/auto/message.ts 的 tryClaimUserReplyTrigger 在
 * 冷却期满后自动清理。
 */
export const userReplyTriggerTimes: Map<string, number> = new Map();
