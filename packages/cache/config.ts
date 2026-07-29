import type { AdSampleConfig } from "../config/adSamples";
import type { MoodConfig } from "../config/mood";
import type { ReactionConfig } from "../config/reactions";
import type { StickerConfig } from "../config/stickers";
import type { ConfigReadinessCache } from "../types/config";

/**
 * 四份部署配置单例缓存的内存状态：defaultMoodConfigCache 属
 * packages/config/mood.ts、defaultReactionConfigCache 属 packages/config/reactions.ts、
 * defaultStickerConfigCache 属 packages/config/stickers.ts、defaultAdSampleConfigCache
 * 属 packages/config/adSamples.ts，四者相互独立。
 *
 * 下方三个 readiness holder 属 packages/config/readiness.ts：按功能聚合上面这几份
 * 文件（外加日语翻译的 g-auth.json）的可用性结论。
 */

/** 默认心情配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘；自定义路径加载不进入缓存。 */
export const defaultMoodConfigCache: { current: MoodConfig | null } = { current: null };
/** 默认反应配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultReactionConfigCache: { current: ReactionConfig | null } = { current: null };
/** 默认贴纸配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultStickerConfigCache: { current: StickerConfig | null } = { current: null };
/** 默认广告示例配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultAdSampleConfigCache: { current: AdSampleConfig | null } = { current: null };

/**
 * AI 闲聊三份部署配置的可用性结论；首次判定填充，此后不再读盘。**失败结论
 * 同样缓存**：这道判定挂在 /ai_chat enable 与投喂门禁上，不缓存失败等于每条
 * 群消息一次 readFileSync。修好文件需要重启才生效，与底层 loader 的单例语义一致。
 */
export const aiChatConfigReadinessCache: ConfigReadinessCache = { current: null };
/** 广告示例配置的可用性结论；语义同 aiChatConfigReadinessCache。 */
export const adDetectConfigReadinessCache: ConfigReadinessCache = { current: null };
/** 日语翻译服务账号密钥（g-auth.json）的可用性结论；语义同上。 */
export const jaTranslateConfigReadinessCache: ConfigReadinessCache = { current: null };
