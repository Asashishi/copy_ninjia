/** 贴纸目录落盘（src/workers/diskIO/stickerCatalogFiles.ts）的内存状态。 */

/** 贴纸目录快照、dirty 集合及其 flush timer 的唯一 owner。 */
export const stickerCatalogCache: Map<string, string> = new Map();
/** 需要在下一轮 flush 写入的贴纸包；成功写入或 reset 时删除。 */
export const dirtyStickerPacks: Set<string> = new Set();
/** 贴纸目录批量刷盘 timer；首次 dirty 创建，flush/reset 时清除。 */
export const stickerFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

/** 启动恢复时整体替换目录镜像并清除旧 dirty/timer。 */
export function hydrateStickerCatalogCache(snapshots: ReadonlyMap<string, string>): void {
  if (stickerFlushState.timer !== null) clearTimeout(stickerFlushState.timer);
  stickerFlushState.timer = null;
  stickerCatalogCache.clear();
  dirtyStickerPacks.clear();
  for (const [pack, snapshot] of snapshots) stickerCatalogCache.set(pack, snapshot);
}

/** 更新包快照并标为待刷；镜像容量受配置白名单包数约束。 */
export function markStickerCatalogDirty(pack: string, snapshot: string): void {
  stickerCatalogCache.set(pack, snapshot);
  dirtyStickerPacks.add(pack);
}

/** Worker 停止或测试隔离时取消 timer 并清空目录镜像。 */
export function resetStickerCatalogCache(): void {
  if (stickerFlushState.timer !== null) clearTimeout(stickerFlushState.timer);
  stickerFlushState.timer = null;
  stickerCatalogCache.clear();
  dirtyStickerPacks.clear();
}
