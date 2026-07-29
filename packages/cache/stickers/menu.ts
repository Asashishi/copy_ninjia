import type { StickerPackCandidate } from "../../types/stickers/tools";

/**
 * 贴纸包菜单（packages/ai/tools/stickers.ts 的 buildStickerPackMenu）的记忆化状态。
 * 只由该文件读写；随 AI 闲聊 Worker isolate 生死，崩溃重启后从 0 重建。
 *
 * 菜单的两个输入——贴纸集合缓存（cache/stickers/sets.ts）与画面描述目录/整包简介
 * （cache/stickers/catalog.ts）——都是无 TTL 的进程内缓存，稳态下根本不变，而
 * `createReplyToolset` 每轮回复都要一份菜单（每群最多 5 轮并发）。不记忆化的话，
 * 每一轮都在重跑一遍 `Promise.allSettled` 并重新分配一份数百对象的相同结构，
 * 纯 GC 压力。
 */

/**
 * 菜单输入的版本号：贴纸集合缓存新增条目、目录条目增删、整包简介写入时各 +1。
 *
 * 用独立计数器而不是复用 `dirtyPacks`：那张表由 `flushDirtyStickerCatalogs` 上报
 * 完就清空，拿它当失效信号会在上报之后立刻把菜单判成「没变过」。
 */
export const stickerMenuRevision: { current: number } = { current: 0 };

/** 上次构建出的菜单及其版本号；版本仍一致就直接复用同一份（调用方只读）。 */
export const stickerMenuCache: {
  current: { revision: number; menu: readonly StickerPackCandidate[] } | null;
} = { current: null };

/** 正在构建中的菜单：冷启动时几轮回复同时开工，只让第一轮真的去拉。 */
export const stickerMenuInflight: {
  current: { revision: number; promise: Promise<readonly StickerPackCandidate[]> } | null;
} = { current: null };

/** 目录/贴纸集合发生变化时调用；下一次取菜单会重建。 */
export function invalidateStickerMenu(): void {
  stickerMenuRevision.current++;
}
