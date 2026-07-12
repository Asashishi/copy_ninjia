import type { StickerSet } from "@grammyjs/types";

/** 贴纸包公共积木（src/ai/stickerSets.ts）的内存缓存。 */

/** 各包的贴纸集合缓存（进程内，重启即刷新——包内容本就极少变动）。 */
export const stickerSetCache: Map<string, StickerSet> = new Map();
/** 已知拉取失败的包，避免每次触发都重复打一次必失败的请求。 */
export const failedPacks: Set<string> = new Set();
