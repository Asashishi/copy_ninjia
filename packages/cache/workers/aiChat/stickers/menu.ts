/** owner: workers/aiChat。贴纸包菜单（packages/aiChat/ai/tools/stickers.ts 的 buildStickerPackMenu）的记忆化状态。
 * 只由该文件读写；随 AI 闲聊 Worker isolate 生死，崩溃重启后从 0 重建。
 *
 * 菜单的两个输入是贴纸集合缓存（cache/workers/aiChat/stickers/sets.ts）与画面描述目录/整包简介
 * （cache/workers/aiChat/stickers/catalog.ts），都是无 TTL 的进程内缓存；
 * `createReplyToolset` 每轮回复取一份菜单，版本号一致时直接复用
 * 上次构建结果，不重跑 `Promise.allSettled`。
 *
 * 填充：取菜单时版本号与缓存不一致就重建一次，构建期间版本没再变才写回缓存。
 * 清理：版本号只增不减；旧版本的缓存留到下一次重建时被整体覆盖，在途条目在构建结算后清空。
 * 容量：菜单缓存与在途条目各至多一份，不设淘汰。
 */

import type { StickerPackCandidate } from "../../../../types/stickers/tools";

/**
 * 菜单输入的版本号（经 invalidateStickerMenu 递增）：贴纸集合缓存写入、目录 hydrate、
 * 目录条目剪枝或整包移除、配置重载时当场 +1；一次包对账新写入的描述与整包简介在该包
 * 结算时合计 +1。
 */
export const stickerMenuRevision: { current: number } = { current: 0 };

/** 上次构建出的菜单及其版本号；版本仍一致就直接复用同一份（调用方只读）。 */
export const stickerMenuCache: {
  current: { revision: number; menu: readonly StickerPackCandidate[] } | null;
} = { current: null };

/** 正在构建中的菜单；同版本的并发取用复用同一次构建。 */
export const stickerMenuInflight: {
  current: { revision: number; promise: Promise<readonly StickerPackCandidate[]> } | null;
} = { current: null };

/** 目录/贴纸集合发生变化时调用；下一次取菜单会重建。 */
export function invalidateStickerMenu(): void {
  stickerMenuRevision.current++;
}
