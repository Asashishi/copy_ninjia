import type { StickerSet } from "grammy/types";

/** owner：aiChat Worker。贴纸包集合的权威内存缓存。
 * 仅 aiChat/ai/stickers/sets.ts 直接读写；成功结果不落盘、无 TTL，容量由有限的配置
 * 白名单自然约束，Worker 重启清空后按需从 Telegram 重拉。失败项只保留
 * STICKER_SET_FAILURE_RETRY_MS 的负缓存窗口，到期后的下一次调用可重新拉取。 */

/** 拉取成功且仍在当前白名单中的贴纸集合；Worker 重建后清空并按需重拉。
 *  清理：配置轮换时删除退出白名单的包，Worker isolate 销毁时整体释放。
 *  容量：配置白名单包数，不另设淘汰。 */
export const stickerSetCache: Map<string, StickerSet> = new Map();
/** 拉取失败且仍在当前白名单的包 -> 允许再次尝试的时间戳。
 * TTL 内调用直接返回 null，到期后下一次调用可重新拉取；Worker 重建后清空。
 * 清理：配置轮换时删除退出白名单的包，到期后由下一次拉取删除，isolate 销毁时释放。
 * 容量：配置白名单包数，不另设淘汰。 */
export const failedPacks: Map<string, number> = new Map();
/** 各包在途的拉取 Promise：首次拉取时登记，并发调用复用同包请求，结算后移除。
 * 容量：当前配置与轮换前尚未结算的请求数；移出白名单不阻断已有等待者。
 * Worker 重建后清空，由后续拉取重新登记；取消边界见 docs/cn/04-invariants.md。 */
export const inflightStickerSets: Map<string, Promise<StickerSet | null>> = new Map();
