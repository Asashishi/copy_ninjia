import type { ReactionEmoji } from "../types/config";

/** 与当前 Telegram Bot API 标准反应集合保持一致，供部署配置做运行时校验。 */
export const TELEGRAM_REACTION_EMOJIS: readonly ReactionEmoji[] = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢",
  "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳",
  "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓",
  "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿",
  "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
] as const;

/**
 * TELEGRAM_REACTION_EMOJIS 的查找表形态，供 packages/config/reactions.ts 解码
 * reactions.json 时逐个校验 emoji。与上面的数组同源、内容恒等，只是把 O(n)
 * 的线性查找换成 O(1)；模块加载时构造一次，此后只读，因此是常量而不是缓存。
 */
export const TELEGRAM_REACTION_EMOJI_SET: ReadonlySet<string> = new Set(TELEGRAM_REACTION_EMOJIS);
