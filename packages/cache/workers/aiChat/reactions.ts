/** AI 反应工具（packages/aiChat/ai/reactions.ts）的内存状态。 */

/**
 * AI 反应工具从部署配置派生出的进程内只读缓存：首次取用时从 reactions.json
 * 的 emotionKeywords 键集冻结一份，此后不再重算；随 AI 闲聊 Worker isolate
 * 生死，重建后按同一份配置重新派生。
 */
export const reactionEmojiCache: { current: readonly string[] | null } = { current: null };
