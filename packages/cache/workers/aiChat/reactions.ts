/** AI 反应工具（packages/aiChat/ai/reactions.ts）的内存状态。 */

/**
 * AI 反应工具从部署配置派生出的进程内只读缓存：首次取用时从 reactions.json
 * 的 emotionKeywords 键集冻结一份，此后不再重算；随 AI 闲聊 Worker isolate
 * 生死，销毁时清除，重建后按同一份配置重新派生。容量固定为一个数组，运行中
 * 不淘汰。
 */
export const reactionEmojiCache: { current: readonly string[] | null } = { current: null };
