import { TELEGRAM_REACTION_EMOJIS } from "../consts/reactions";

/** AI 反应工具从部署配置派生出的进程内只读缓存。 */
export const reactionEmojiCache: { current: readonly string[] | null } = { current: null };

/**
 * reactions.json 解码时使用的 Telegram 标准反应查找表。模块加载时填充且不清理；
 * 进程重启后从常量全集重建，容量固定为 Telegram 支持的反应数。
 */
export const allowedReactionEmojis: ReadonlySet<string> = new Set(TELEGRAM_REACTION_EMOJIS);
