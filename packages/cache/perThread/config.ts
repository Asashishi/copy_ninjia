import type {
  AdSampleConfig,
  MoodConfig,
  ReactionConfig,
  StickerConfig,
} from "../../types/config";

/**
 * 四份部署配置单例缓存的内存状态：defaultMoodConfigCache 属
 * packages/config/mood.ts、defaultReactionConfigCache 属 packages/config/reactions.ts、
 * defaultStickerConfigCache 属 packages/config/stickers.ts、defaultAdSampleConfigCache
 * 属 packages/config/adSamples.ts，四者相互独立。
 *
 * perThread：四份 loader 各自被两条以上线程加载（心情/反应在主线程与 AI 闲聊
 * Worker，贴纸连 Disk I/O Worker 也要，广告示例在主线程与 Anti-Raid Worker），
 * 各持一份从同一个只读文件解出来的副本。不做跨线程共享也不需要——配置在进程
 * 生命周期内不变，重复解析一次的代价远低于为它铺一条消息通道。
 *
 * 按功能聚合的可用性结论只有主线程用，因此不在这里，见
 * cache/main/configReadiness.ts。
 */

/** 默认心情配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘；自定义路径加载不进入缓存。 */
export const defaultMoodConfigCache: { current: MoodConfig | null } = { current: null };
/** 默认反应配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultReactionConfigCache: { current: ReactionConfig | null } = { current: null };
/** 默认贴纸配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultStickerConfigCache: { current: StickerConfig | null } = { current: null };
/** 默认广告示例配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultAdSampleConfigCache: { current: AdSampleConfig | null } = { current: null };
