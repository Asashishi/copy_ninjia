import type { ReactionConfig } from "../config/reactions";
import type { StickerConfig } from "../config/stickers";

/** 默认部署配置按进程/Worker 惰性加载一次；自定义路径加载不进入缓存。 */
export const defaultReactionConfigCache: { current: ReactionConfig | null } = { current: null };
export const defaultStickerConfigCache: { current: StickerConfig | null } = { current: null };
