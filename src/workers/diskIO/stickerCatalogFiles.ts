import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../../consts/diskIO/snapshots";
import {
  dirtyStickerPacks,
  hydrateStickerCatalogCache,
  markStickerCatalogDirty,
  resetStickerCatalogCache,
  stickerCatalogCache,
  stickerFlushState,
} from "../../cache/diskIO/stickers";
import { flushDirtyEntries } from "./dirtyFlush";
import { recoverStickerCatalogs, writeStickerCatalogFile } from "./snapshotFiles";

function scheduleStickerCatalogFlush(): void {
  if (stickerFlushState.timer !== null) return;
  stickerFlushState.timer = setTimeout(() => {
    stickerFlushState.timer = null;
    flushStickerCatalogs();
  }, SNAPSHOT_FLUSH_INTERVAL_MS);
}

/** 启动恢复边界：按当前白名单对账后整体替换内存 owner。 */
export function hydrateStickerCatalogs(activePacks: readonly string[]): Map<string, string> {
  hydrateStickerCatalogCache(recoverStickerCatalogs(activePacks));
  return stickerCatalogCache;
}

/** 覆盖式目录的 markDirty 边界。 */
export function markStickerCatalogSnapshotDirty(pack: string, snapshot: string): void {
  markStickerCatalogDirty(pack, snapshot);
  scheduleStickerCatalogFlush();
}

/** flush 边界：逐包写入，单包失败保留 dirty 并自动重排。 */
export function flushStickerCatalogs(): void {
  if (stickerFlushState.timer !== null) {
    clearTimeout(stickerFlushState.timer);
    stickerFlushState.timer = null;
  }
  flushDirtyEntries(
    dirtyStickerPacks,
    stickerCatalogCache,
    writeStickerCatalogFile,
    (pack: string) => `[diskIOWorker] failed to write sticker catalog for pack "${pack}":`
  );
  if (dirtyStickerPacks.size > 0) scheduleStickerCatalogFlush();
}

/** reset 边界：停止 timer 并清空恢复态与 dirty 集合。 */
export function resetStickerCatalogFiles(): void {
  resetStickerCatalogCache();
}
