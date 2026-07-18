/** 贴纸目录快照、dirty 集合及其 flush timer 的唯一 owner。 */
export const stickerCatalogCache: Map<string, string> = new Map();
export const dirtyStickerPacks: Set<string> = new Set();
export const stickerFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

export function hydrateStickerCatalogCache(snapshots: ReadonlyMap<string, string>): void {
  if (stickerFlushState.timer !== null) clearTimeout(stickerFlushState.timer);
  stickerFlushState.timer = null;
  stickerCatalogCache.clear();
  dirtyStickerPacks.clear();
  for (const [pack, snapshot] of snapshots) stickerCatalogCache.set(pack, snapshot);
}

export function markStickerCatalogDirty(pack: string, snapshot: string): void {
  stickerCatalogCache.set(pack, snapshot);
  dirtyStickerPacks.add(pack);
}

export function resetStickerCatalogCache(): void {
  if (stickerFlushState.timer !== null) clearTimeout(stickerFlushState.timer);
  stickerFlushState.timer = null;
  stickerCatalogCache.clear();
  dirtyStickerPacks.clear();
}
