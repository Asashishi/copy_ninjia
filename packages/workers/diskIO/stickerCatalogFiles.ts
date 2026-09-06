import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../../consts/diskIO/snapshots";
import {
  dirtyStickerPacks,
  hydrateStickerCatalogCache,
  markStickerCatalogDirty,
  stickerCatalogCache,
  stickerFlushState,
} from "../../cache/workers/diskIO/stickers";
import { flushDirtyEntries } from "./dirtyFlush";
import {
  inspectStickerCatalogs,
  maintainStickerCatalogFiles,
  writeStickerCatalogFile,
} from "./snapshotFiles";
import type { StickerCatalogFileDependencies } from "../../types/diskIO/snapshotOwners";
import type { StickerCatalogRecoveryInspection } from "./snapshotFiles";

const STICKER_CATALOG_FILE_DEPENDENCIES: StickerCatalogFileDependencies = {
  write: writeStickerCatalogFile,
};

function scheduleStickerCatalogFlush(): void {
  if (stickerFlushState.timer !== null) return;
  stickerFlushState.timer = setTimeout((): void => {
    stickerFlushState.timer = null;
    flushStickerCatalogs();
  }, SNAPSHOT_FLUSH_INTERVAL_MS);
  stickerFlushState.timer.unref();
}

/** 跨域启动第一阶段：只读扫描全部目录快照，孤儿也先严格解码。 */
export async function inspectStickerCatalogSnapshots(
  activePacks: readonly string[] | null
): Promise<StickerCatalogRecoveryInspection> {
  return inspectStickerCatalogs(activePacks);
}

/** 跨域启动第二阶段：全部领域 inspect 成功后整体发布到 owner 缓存。 */
export function adoptStickerCatalogSnapshots(
  inspection: StickerCatalogRecoveryInspection
): Map<string, string> {
  hydrateStickerCatalogCache(inspection.snapshots);
  return stickerCatalogCache;
}

/** 跨域启动成功后的临时文件与已验证孤儿清理。 */
export async function maintainStickerCatalogSnapshots(
  inspection: StickerCatalogRecoveryInspection
): Promise<void> {
  await maintainStickerCatalogFiles(inspection);
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
