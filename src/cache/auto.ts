/** 消息自动流水线（src/auto）的内存状态。 */

/**
 * 记录各用户上一次被 AI 随机回复的时刻（以 chatId + 用户 id 拼接作为 key）。
 * 条目由 src/auto/message.ts 的 tryClaimUserRandomReply 在冷却期满后自动清理。
 */
export const userRandomReplyTimes: Map<string, number> = new Map();
