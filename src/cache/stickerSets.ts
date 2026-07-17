import type { StickerSet } from "@grammyjs/types";

/** 贴纸包公共积木（src/ai/stickerSets.ts）的内存缓存。 */

/** 各包的贴纸集合缓存（进程内，重启即刷新——包内容本就极少变动）。 */
export const stickerSetCache: Map<string, StickerSet> = new Map();
/** 拉取失败的包 -> 允许再次尝试的时间戳。短期负缓存避免故障时每轮回复都
 * 重打请求，但不能永久封死：瞬时网络错误恢复后应在本进程内自动重试。 */
export const failedPacks: Map<string, number> = new Map();
