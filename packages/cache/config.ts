import type { AdSampleConfig } from "../config/adSamples";
import type { MoodConfig } from "../config/mood";
import type { ReactionConfig } from "../config/reactions";
import type { StickerConfig } from "../config/stickers";

/**
 * 四份部署配置单例缓存的内存状态：defaultMoodConfigCache 属
 * packages/config/mood.ts、defaultReactionConfigCache 属 packages/config/reactions.ts、
 * defaultStickerConfigCache 属 packages/config/stickers.ts、defaultAdSampleConfigCache
 * 属 packages/config/adSamples.ts，四者相互独立。
 */

/** 默认心情配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘；自定义路径加载不进入缓存。 */
export const defaultMoodConfigCache: { current: MoodConfig | null } = { current: null };
/** 默认反应配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultReactionConfigCache: { current: ReactionConfig | null } = { current: null };
/** 默认贴纸配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultStickerConfigCache: { current: StickerConfig | null } = { current: null };
/** 默认广告示例配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultAdSampleConfigCache: { current: AdSampleConfig | null } = { current: null };
