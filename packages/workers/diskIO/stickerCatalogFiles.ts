import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../../consts/diskIO/snapshots";
import {
  dirtyStickerPacks,
  hydrateStickerCatalogCache,
  markStickerCatalogDirty,
  resetStickerCatalogCache,
  stickerCatalogCache,
  stickerFlushState,
} from "../../cache/workers/diskIO/stickers";
import { flushDirtyEntries } from "./dirtyFlush";
import { recoverStickerCatalogs, writeStickerCatalogFile } from "./snapshotFiles";
import type { StickerCatalogFileDependencies } from "../../types/diskIO/snapshotOwners";

const STICKER_CATALOG_FILE_DEPENDENCIES: StickerCatalogFileDependencies = {
  recover: recoverStickerCatalogs,
  write: writeStickerCatalogFile,
};

function scheduleStickerCatalogFlush(): void {
  if (stickerFlushState.timer !== null) return;
  stickerFlushState.timer = setTimeout((): void => {
    stickerFlushState.timer = null;
    flushStickerCatalogs();
  }, SNAPSHOT_FLUSH_INTERVAL_MS);
}

/**
 * 启动恢复边界：按当前白名单对账后整体替换内存 owner。
 * @param activePacks 已严格校验的贴纸白名单。
 */
export function hydrateStickerCatalogs(
  activePacks: readonly string[],
  files: StickerCatalogFileDependencies = STICKER_CATALOG_FILE_DEPENDENCIES
): Map<string, string> {
  hydrateStickerCatalogCache(files.recover(activePacks));
  return stickerCatalogCache;
}

/** 覆盖式目录的 markDirty 边界。 */
export function markStickerCatalogSnapshotDirty(pack: string, snapshot: string): void {
  markStickerCatalogDirty(pack, snapshot);
  scheduleStickerCatalogFlush();
}

/** flush 边界：逐包写入，单包失败保留 dirty 并自动重排。 */
export function flushStickerCatalogs(
  files: StickerCatalogFileDependencies = STICKER_CATALOG_FILE_DEPENDENCIES
): boolean {
  if (stickerFlushState.timer !== null) {
    clearTimeout(stickerFlushState.timer);
    stickerFlushState.timer = null;
  }
  flushDirtyEntries({
    dirty: dirtyStickerPacks,
    cache: stickerCatalogCache,
    write: (pack: string, snapshot: string): void => { files.write(pack, snapshot); },
    describeFailure: (pack: string): string => `[diskIOWorker] failed to write sticker catalog for pack "${pack}":`,
  });
  if (dirtyStickerPacks.size > 0) scheduleStickerCatalogFlush();
  return dirtyStickerPacks.size === 0;
}

/** reset 边界：停止 timer 并清空恢复态与 dirty 集合。 */
export function resetStickerCatalogFiles(): void {
  resetStickerCatalogCache();
}
