import { afterEach, expect, spyOn, test } from "bun:test";
import { markStickerCatalogSnapshotDirty, flushStickerCatalogs } from "../../../packages/workers/diskIO/stickerCatalogFiles";
import {
  dirtyStickerPacks,
  resetStickerCatalogCache,
  stickerCatalogCache,
  stickerCatalogPersistedNotifier,
  stickerCatalogRevisions,
  stickerFlushState,
} from "../../../packages/cache/workers/diskIO/stickers";
import type { StickerCatalogPersistedReply } from "../../../packages/types/diskIO/replies";

const previousNotifier: (reply: StickerCatalogPersistedReply) => void = stickerCatalogPersistedNotifier.current;
afterEach((): void => {
  resetStickerCatalogCache();
  stickerCatalogPersistedNotifier.current = previousNotifier;
});

test("失败保留最新快照与编号，成功写入后回执并回收全部缓冲", (): void => {
  const receipts: StickerCatalogPersistedReply[] = [];
  stickerCatalogPersistedNotifier.current = (reply: StickerCatalogPersistedReply): void => { receipts.push(reply); };
  markStickerCatalogSnapshotDirty("pack_one", "old", 1);
  markStickerCatalogSnapshotDirty("pack_one", "latest", 2);
  const errors: { mockRestore(): void } = spyOn(console, "error").mockImplementation((): void => {});
  try {
    expect(flushStickerCatalogs({ write: (): never => { throw new Error("Mock disk full"); } })).toBeFalse();
    expect(receipts).toEqual([]);
    expect(stickerCatalogCache.get("pack_one")).toBe("latest");
    expect(stickerCatalogRevisions.get("pack_one")).toBe(2);
    expect(dirtyStickerPacks.has("pack_one")).toBeTrue();
    expect(stickerFlushState.timer).not.toBeNull();
    const writes: string[] = [];
    expect(flushStickerCatalogs({ write: (_pack: string, snapshot: string): void => { writes.push(snapshot); } })).toBeTrue();
    expect(writes).toEqual(["latest"]);
    expect(receipts).toEqual([{ type: "stickerCatalogPersisted", pack: "pack_one", revision: 2 }]);
    expect(stickerCatalogCache.size).toBe(0);
    expect(stickerCatalogRevisions.size).toBe(0);
    expect(dirtyStickerPacks.size).toBe(0);
    expect(stickerFlushState.timer).toBeNull();
  } finally { errors.mockRestore(); }
});

test("轮换包名并逐次落盘后不保留历史快照", (): void => {
  let acknowledged: number = 0;
  stickerCatalogPersistedNotifier.current = (): void => { acknowledged++; };
  for (let index: number = 0; index < 200; index++) {
    markStickerCatalogSnapshotDirty(`pack_${index}`, "snapshot", index + 1);
    expect(flushStickerCatalogs({ write: (): void => {} })).toBeTrue();
    expect(stickerCatalogCache.size).toBe(0);
    expect(stickerCatalogRevisions.size).toBe(0);
  }
  expect(acknowledged).toBe(200);
});
