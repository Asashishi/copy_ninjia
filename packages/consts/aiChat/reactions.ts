import type { ReactionEmoji } from "../../types/telegram";

/**
 * AI 闲聊 add_reaction 工具允许的表情反应，属 aiChat/ai/tools/replyToolset/。
 *
 * 元素限定为 Bot API 的标准反应 emoji（ReactionTypeEmoji）：bot 账号只能设置这份
 * 固定集合内的反应，任意 emoji 或自定义表情一律报 REACTION_INVALID，集合外的
 * 取值在编译期即被拒绝。数组顺序就是工具说明里展示给模型的顺序。
 */
export const AI_REACTION_EMOJIS: readonly ReactionEmoji[] = [
  "🤣", "😁", "😡", "🤬", "😢", "😭", "🥰", "😍", "❤", "❤‍🔥", "😱", "🤯", "🤨", "😐",
  "🥱", "😴", "🥴", "🤡", "🗿", "👍", "💯", "🏆", "👎", "🤮", "🙏", "👌", "🙈", "😇",
  "😨", "🤝", "🤗", "💅", "🤪", "😘", "😎", "🤷", "😈", "🖕", "💋", "👨‍💻", "👀",
];

/**
 * AI_REACTION_EMOJIS 的查找表形态，供 add_reaction 执行器校验模型给出的 emoji；
 * 与数组同源、内容恒等，模块加载时构造一次，此后只读。
 */
export const AI_REACTION_EMOJI_SET: ReadonlySet<string> = new Set(AI_REACTION_EMOJIS);
