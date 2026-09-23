import { latestStickerCatalogs } from "../cache/main/aiChat";
import {
  pendingStickerCatalogRevisions,
  stickerCatalogRevisionCounter,
} from "../cache/main/stickers";
import { stickerPacksForRecovery } from "../config/stickers";
import { onDiskIOReply, postDiskIO } from "../infra/diskIO";
import type { StickerCatalogPersistedReply } from "../types/diskIO/replies";

/** 接管 Worker 快照；即使包已移出配置，也保留到最新编号 durable 后再释放。 */
export function mirrorStickerCatalog(pack: string, snapshot: string): void {
  const revision: number = ++stickerCatalogRevisionCounter.current;
  latestStickerCatalogs.set(pack, snapshot);
  pendingStickerCatalogRevisions.set(pack, revision);
  postDiskIO({ type: "stickerCatalog", pack, snapshot, revision });
}

/** 配置轮换只回收已确认且不再使用的镜像；待写快照仍是 Disk I/O 崩溃重放源。 */
export function pruneStickerCatalogMirror(activePacks: readonly string[]): void {
  for (const pack of latestStickerCatalogs.keys()) {
    if (!activePacks.includes(pack) && !pendingStickerCatalogRevisions.has(pack)) {
      latestStickerCatalogs.delete(pack);
    }
  }
}

/** AI Worker 只恢复当前白名单；待落盘的旧包仍保留在主线程供 Disk I/O 重放。 */
export function activeStickerCatalogs(): Map<string, string> {
  const catalogs: Map<string, string> = new Map();
  const activePacks: readonly string[] | null = stickerPacksForRecovery();
  if (activePacks === null) return catalogs;
  for (const [pack, snapshot] of latestStickerCatalogs) {
    if (activePacks.includes(pack)) catalogs.set(pack, snapshot);
  }
  return catalogs;
}

onDiskIOReply("stickerCatalogPersisted", (reply: StickerCatalogPersistedReply): void => {
  if (pendingStickerCatalogRevisions.get(reply.pack) !== reply.revision) return;
  pendingStickerCatalogRevisions.delete(reply.pack);
  if (!stickerPacksForRecovery()?.includes(reply.pack)) latestStickerCatalogs.delete(reply.pack);
});
