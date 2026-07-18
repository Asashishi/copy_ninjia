import { getReactionConfig } from "../config/reactions";

/**
 * add_reaction 工具的 emoji 白名单，来自 config/reactions.json 的
 * emotionKeywords key 集合（不进 .gitignore）。消息反应已改为模型自主决定
 * 的工具（见 ai/tools/replyToolset.ts），配置里的关键词映射不再使用，
 * 只有 key 集合还承担「允许哪些 emoji」这一职责——它必须落在 Telegram
 * 文档列出的固定反应表情集合内（ReactionTypeEmoji）：Bot API 不允许 bot
 * 给消息设置任意 emoji 或消息上原本不存在的自定义表情反应（实测均报
 * REACTION_INVALID，与是否有 Telegram Premium 无关，是 bot 账号的硬限制）。
 */

let cachedEmojis: readonly string[] | null = null;

/** add_reaction 工具允许的标准反应 emoji；首次业务调用时才读取配置。 */
export function getReactionEmojis(): readonly string[] {
  cachedEmojis ??= Object.freeze(Object.keys(getReactionConfig().emotionKeywords));
  return cachedEmojis;
}
