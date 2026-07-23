import type { MoodConfig } from "../config/mood";
import type { ReactionConfig } from "../config/reactions";
import type { StickerConfig } from "../config/stickers";

/** 默认部署配置按进程/Worker 惰性加载一次；自定义路径加载不进入缓存。 */
export const defaultMoodConfigCache: { current: MoodConfig | null } = { current: null };
/** 默认反应配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultReactionConfigCache: { current: ReactionConfig | null } = { current: null };
/** 默认贴纸配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultStickerConfigCache: { current: StickerConfig | null } = { current: null };
