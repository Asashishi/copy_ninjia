import type { StickerSet } from "@grammyjs/types";

/** 贴纸包集合（src/ai/stickers/sets.ts）的权威内存缓存。
 * 仅 ai/stickers/sets.ts 直接读写；成功结果不落盘、无 TTL，容量由有限的配置
 * 白名单自然约束，Worker 重启清空后按需从 Telegram 重拉。失败项只保留
 * STICKER_SET_FAILURE_RETRY_MS 的负缓存窗口，到期自动重试。 */

/** 各包的贴纸集合缓存（进程内，重启即刷新——包内容本就极少变动）。 */
export const stickerSetCache: Map<string, StickerSet> = new Map();
/** 拉取失败的包 -> 允许再次尝试的时间戳。短期负缓存避免故障时每轮回复都
 * 重打请求，但不能永久封死：瞬时网络错误恢复后应在本进程内自动重试。 */
export const failedPacks: Map<string, number> = new Map();
