import type { StickerCatalogPersistedReply } from "../../../types/diskIO/replies";

/** 贴纸目录落盘（packages/workers/diskIO/stickerCatalogFiles.ts）的内存状态；Worker
 * 重建时由磁盘快照重新填充，恢复前保持空表。 */

/**
 * 贴纸目录快照、dirty 集合及其 flush timer 的唯一 owner。
 *
 * 填充：hydrate 从磁盘快照整体替换，此后 markStickerCatalogDirty 逐包覆盖。
 * 清理：flush 后释放全部非 dirty 快照；hydrate/reset 清空后按新快照填充。
 * Worker 崩溃重建：load 后的 hydrate 从 memory/ 的目录文件重读。
 * 容量：启动恢复的白名单包及当前待写包；写入失败期间保留重试责任。
 */
export const stickerCatalogCache: Map<string, string> = new Map();
/**
 * 需要在下一轮 flush 写入的贴纸包；成功写入或 reset 时删除。
 * 容量：stickerCatalogCache 的待写子集，成功写入后释放。
 */
export const dirtyStickerPacks: Set<string> = new Set();
/** 待写目录的回执编号；mark 时覆盖，成功 flush 或 hydrate/reset 时删除。
 * owner 为 diskIO Worker，容量等于 dirty 包数；崩溃后由主线程未确认镜像重放。 */
export const stickerCatalogRevisions: Map<string, number> = new Map();
/** owner 为 diskIO Worker；入口初始化唯一 durable 回执出口，isolate 销毁时释放。 */
export const stickerCatalogPersistedNotifier: {
  current: (reply: StickerCatalogPersistedReply) => void;
} = { current: (): void => { /* Worker 入口在接收消息前注入。 */ } };
/** 贴纸目录批量刷盘 timer；首次 dirty 创建，flush/reset 时清除。 */
export const stickerFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

/** 启动恢复时整体替换目录镜像并清除旧 dirty/timer。 */
export function hydrateStickerCatalogCache(snapshots: ReadonlyMap<string, string>): void {
  if (stickerFlushState.timer !== null) clearTimeout(stickerFlushState.timer);
  stickerFlushState.timer = null;
  stickerCatalogCache.clear();
  dirtyStickerPacks.clear();
  stickerCatalogRevisions.clear();
  for (const [pack, snapshot] of snapshots) stickerCatalogCache.set(pack, snapshot);
}

/** 更新包快照及回执编号并标为待刷；成功写入前保留最新一份。 */
export function markStickerCatalogDirty(pack: string, snapshot: string, revision: number): void {
  stickerCatalogCache.set(pack, snapshot);
  dirtyStickerPacks.add(pack);
  stickerCatalogRevisions.set(pack, revision);
}

/** 测试隔离时取消 timer 并清空目录镜像；生产代码不调用，Worker 停止时随 isolate 释放。 */
export function resetStickerCatalogCache(): void {
  if (stickerFlushState.timer !== null) clearTimeout(stickerFlushState.timer);
  stickerFlushState.timer = null;
  stickerCatalogCache.clear();
  dirtyStickerPacks.clear();
  stickerCatalogRevisions.clear();
}
