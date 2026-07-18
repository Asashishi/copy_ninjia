import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const recoveredAi: Map<number, string> = new Map<number, string>([[1, "ai-one"]]);
const recoveredStickers: Map<string, string> = new Map<string, string>([["pack_one", "sticker-one"]]);
const recoverAiMemories = mock((): Map<number, string> => new Map(recoveredAi));
const recoverStickerCatalogs = mock((_packs: readonly string[]): Map<string, string> => new Map(recoveredStickers));
const writeAiMemoryFile = mock((_chatId: number, _snapshot: string): void => {});
const deleteAiMemoryFile = mock((_chatId: number): void => {});
const writeStickerCatalogFile = mock((_pack: string, _snapshot: string): void => {});

mock.module("../../../src/workers/diskIO/snapshotFiles", () => ({
  recoverAiMemories,
  recoverStickerCatalogs,
  writeAiMemoryFile,
  deleteAiMemoryFile,
  writeStickerCatalogFile,
}));

const {
  deleteAiMemorySnapshot,
  flushAiMemorySnapshots,
  hydrateAiMemorySnapshots,
  markAiMemorySnapshotDirty,
  resetAiMemoryFiles,
} = await import("../../../src/workers/diskIO/aiMemoryFiles");
const {
  flushStickerCatalogs,
  hydrateStickerCatalogs,
  markStickerCatalogSnapshotDirty,
  resetStickerCatalogFiles,
} = await import("../../../src/workers/diskIO/stickerCatalogFiles");
const {
  aiMemoryCache,
  aiMemoryFlushState,
  deletedAiMemoryChats,
  dirtyChats,
} = await import("../../../src/cache/diskIO/snapshots");
const {
  dirtyStickerPacks,
  stickerCatalogCache,
  stickerFlushState,
} = await import("../../../src/cache/diskIO/stickers");

beforeEach(() => {
  resetAiMemoryFiles();
  resetStickerCatalogFiles();
  recoverAiMemories.mockClear();
  recoverStickerCatalogs.mockClear();
  writeAiMemoryFile.mockClear();
  deleteAiMemoryFile.mockClear();
  writeStickerCatalogFile.mockClear();
});

afterEach(() => {
  resetAiMemoryFiles();
  resetStickerCatalogFiles();
});

describe("Disk I/O snapshot domain owners", () => {
  test("hydrate 整体替换旧状态，AI 与贴纸 markDirty/flush 使用独立 timer", () => {
    aiMemoryCache.set(999, "stale-ai");
    dirtyChats.add(999);
    stickerCatalogCache.set("stale_pack", "stale-sticker");
    dirtyStickerPacks.add("stale_pack");

    expect(hydrateAiMemorySnapshots()).toEqual(recoveredAi);
    expect(hydrateStickerCatalogs(["pack_one"])).toEqual(recoveredStickers);
    expect(dirtyChats).toHaveLength(0);
    expect(dirtyStickerPacks).toHaveLength(0);

    markAiMemorySnapshotDirty(2, "ai-two");
    markStickerCatalogSnapshotDirty("pack_two", "sticker-two");
    expect(aiMemoryFlushState.timer).not.toBeNull();
    expect(stickerFlushState.timer).not.toBeNull();
    expect(aiMemoryFlushState.timer).not.toBe(stickerFlushState.timer);

    flushAiMemorySnapshots();
    expect(writeAiMemoryFile).toHaveBeenCalledWith(2, "ai-two");
    expect(dirtyChats).toHaveLength(0);
    expect(aiMemoryFlushState.timer).toBeNull();
    expect(stickerFlushState.timer).not.toBeNull();

    flushStickerCatalogs();
    expect(writeStickerCatalogFile).toHaveBeenCalledWith("pack_two", "sticker-two");
    expect(dirtyStickerPacks).toHaveLength(0);
    expect(stickerFlushState.timer).toBeNull();
  });

  test("单领域 flush/delete 失败保留状态并自动重排，成功重试后清理", () => {
    const errorSpy = spyOn(console, "error").mockImplementation((): void => {});
    writeAiMemoryFile.mockImplementationOnce((): void => { throw new Error("ai write failed"); });
    writeStickerCatalogFile.mockImplementationOnce((): void => { throw new Error("sticker write failed"); });
    deleteAiMemoryFile.mockImplementationOnce((): void => { throw new Error("ai delete failed"); });

    markAiMemorySnapshotDirty(2, "ai-two");
    markStickerCatalogSnapshotDirty("pack_two", "sticker-two");
    flushAiMemorySnapshots();
    flushStickerCatalogs();
    expect(dirtyChats.has(2)).toBeTrue();
    expect(dirtyStickerPacks.has("pack_two")).toBeTrue();
    expect(aiMemoryFlushState.timer).not.toBeNull();
    expect(stickerFlushState.timer).not.toBeNull();

    flushAiMemorySnapshots();
    flushStickerCatalogs();
    expect(dirtyChats).toHaveLength(0);
    expect(dirtyStickerPacks).toHaveLength(0);

    deleteAiMemorySnapshot(2);
    expect(deletedAiMemoryChats.has(2)).toBeTrue();
    expect(aiMemoryFlushState.timer).not.toBeNull();
    flushAiMemorySnapshots();
    expect(deletedAiMemoryChats).toHaveLength(0);
    expect(aiMemoryFlushState.timer).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(3);
    errorSpy.mockRestore();
  });

  test("reset 取消本领域 timer 并清空恢复态、dirty 与待删除集合", () => {
    markAiMemorySnapshotDirty(2, "ai-two");
    markStickerCatalogSnapshotDirty("pack_two", "sticker-two");
    deletedAiMemoryChats.add(3);

    resetAiMemoryFiles();
    resetStickerCatalogFiles();

    expect(aiMemoryCache).toHaveLength(0);
    expect(dirtyChats).toHaveLength(0);
    expect(deletedAiMemoryChats).toHaveLength(0);
    expect(aiMemoryFlushState.timer).toBeNull();
    expect(stickerCatalogCache).toHaveLength(0);
    expect(dirtyStickerPacks).toHaveLength(0);
    expect(stickerFlushState.timer).toBeNull();
  });
});
