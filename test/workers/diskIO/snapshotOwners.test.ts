import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
} from "../../../packages/types/diskIO";

const recoveredAi: Map<number, string> = new Map<number, string>([[1, "ai-one"]]);
const recoveredStickers: Map<string, string> = new Map<string, string>([["pack_one", "sticker-one"]]);
const recoverAiMemories = mock((): Map<number, string> => new Map(recoveredAi));
const recoverStickerCatalogs = mock((_packs: readonly string[]): Map<string, string> => new Map(recoveredStickers));
const writeAiMemoryFile = mock((_chatId: number, _snapshot: string): void => {});
const deleteAiMemoryFile = mock((_chatId: number): void => {});
const writeStickerCatalogFile = mock((_pack: string, _snapshot: string): void => {});
const aiFiles = { recover: recoverAiMemories, write: writeAiMemoryFile, delete: deleteAiMemoryFile };
const stickerFiles = { recover: recoverStickerCatalogs, write: writeStickerCatalogFile };
const deleteReplies: AiMemoryDeletedPersistedReply[] = [];
const persistedReplies: AiMemoryPersistedReply[] = [];

const {
  deleteAiMemorySnapshot,
  configureAiMemoryDeletePersistedReply,
  configureAiMemoryPersistedReply,
  flushAiMemorySnapshots,
  hydrateAiMemorySnapshots,
  markAiMemorySnapshotDirty,
  resetAiMemoryFiles,
} = await import("../../../packages/workers/diskIO/aiMemoryFiles");
const {
  flushStickerCatalogs,
  hydrateStickerCatalogs,
  markStickerCatalogSnapshotDirty,
  resetStickerCatalogFiles,
} = await import("../../../packages/workers/diskIO/stickerCatalogFiles");
const {
  aiMemoryCache,
  aiMemoryFlushState,
  deletedAiMemoryChats,
  dirtyChats,
} = await import("../../../packages/cache/diskIO/snapshots");
const {
  dirtyStickerPacks,
  stickerCatalogCache,
  stickerFlushState,
} = await import("../../../packages/cache/diskIO/stickers");

beforeEach(() => {
  resetAiMemoryFiles();
  resetStickerCatalogFiles();
  recoverAiMemories.mockClear();
  recoverStickerCatalogs.mockClear();
  writeAiMemoryFile.mockClear();
  deleteAiMemoryFile.mockClear();
  writeStickerCatalogFile.mockClear();
  deleteReplies.length = 0;
  persistedReplies.length = 0;
  configureAiMemoryDeletePersistedReply((reply) => { deleteReplies.push(reply); });
  configureAiMemoryPersistedReply((reply) => { persistedReplies.push(reply); });
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

    expect(hydrateAiMemorySnapshots(aiFiles)).toEqual(recoveredAi);
    expect(hydrateStickerCatalogs(["pack_one"], stickerFiles)).toEqual(recoveredStickers);
    expect(dirtyChats).toHaveLength(0);
    expect(dirtyStickerPacks).toHaveLength(0);

    markAiMemorySnapshotDirty({ chatId: 2, revision: 1, snapshot: "ai-two", files: aiFiles });
    markStickerCatalogSnapshotDirty("pack_two", "sticker-two");
    expect(aiMemoryFlushState.timer).not.toBeNull();
    expect(stickerFlushState.timer).not.toBeNull();
    expect(aiMemoryFlushState.timer).not.toBe(stickerFlushState.timer);

    flushAiMemorySnapshots(aiFiles);
    expect(writeAiMemoryFile).toHaveBeenCalledWith(2, "ai-two");
    expect(dirtyChats).toHaveLength(0);
    expect(aiMemoryFlushState.timer).toBeNull();
    expect(stickerFlushState.timer).not.toBeNull();

    flushStickerCatalogs(stickerFiles);
    expect(writeStickerCatalogFile).toHaveBeenCalledWith("pack_two", "sticker-two");
    expect(dirtyStickerPacks).toHaveLength(0);
    expect(stickerFlushState.timer).toBeNull();
  });

  test("purge 后首份 AI 快照立即写盘，失败时保留即时回执语义供 timer 重试", () => {
    writeAiMemoryFile.mockImplementationOnce((): void => { throw new Error("temporary failure"); });
    const errorSpy = spyOn(console, "error").mockImplementation((): void => {});

    markAiMemorySnapshotDirty({
      chatId: 2,
      revision: 3,
      snapshot: "post-purge-memory",
      persistImmediately: true,
      files: aiFiles,
    });

    expect(writeAiMemoryFile).toHaveBeenCalledTimes(1);
    expect(dirtyChats.has(2)).toBeTrue();
    expect(aiMemoryFlushState.timer).not.toBeNull();
    expect(persistedReplies).toEqual([]);

    expect(flushAiMemorySnapshots(aiFiles)).toBeTrue();
    expect(writeAiMemoryFile).toHaveBeenLastCalledWith(2, "post-purge-memory");
    expect(persistedReplies).toEqual([{ type: "aiMemoryPersisted", chatId: 2, revision: 3 }]);
    expect(aiMemoryFlushState.timer).toBeNull();
    errorSpy.mockRestore();
  });

  test("单领域 flush/delete 失败保留状态并自动重排，成功重试后清理", () => {
    const errorSpy = spyOn(console, "error").mockImplementation((): void => {});
    writeAiMemoryFile.mockImplementationOnce((): void => { throw new Error("ai write failed"); });
    writeStickerCatalogFile.mockImplementationOnce((): void => { throw new Error("sticker write failed"); });
    deleteAiMemoryFile.mockImplementationOnce((): void => { throw new Error("ai delete failed"); });

    markAiMemorySnapshotDirty({ chatId: 2, revision: 1, snapshot: "ai-two", files: aiFiles });
    markStickerCatalogSnapshotDirty("pack_two", "sticker-two");
    expect(flushAiMemorySnapshots(aiFiles)).toBeFalse();
    expect(flushStickerCatalogs(stickerFiles)).toBeFalse();
    expect(dirtyChats.has(2)).toBeTrue();
    expect(dirtyStickerPacks.has("pack_two")).toBeTrue();
    expect(aiMemoryFlushState.timer).not.toBeNull();
    expect(stickerFlushState.timer).not.toBeNull();

    expect(flushAiMemorySnapshots(aiFiles)).toBeTrue();
    expect(flushStickerCatalogs(stickerFiles)).toBeTrue();
    expect(dirtyChats).toHaveLength(0);
    expect(dirtyStickerPacks).toHaveLength(0);

    deleteAiMemorySnapshot(2, 2, aiFiles);
    expect(deletedAiMemoryChats.has(2)).toBeTrue();
    expect(aiMemoryFlushState.timer).not.toBeNull();
    expect(flushAiMemorySnapshots(aiFiles)).toBeTrue();
    expect(deletedAiMemoryChats).toHaveLength(0);
    expect(aiMemoryFlushState.timer).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(deleteReplies).toEqual([{ type: "aiMemoryDeletedPersisted", chatId: 2, revision: 2 }]);
    errorSpy.mockRestore();
  });

  test("迟到的旧 revision 删除只回执、不删除更新快照", () => {
    hydrateAiMemorySnapshots(aiFiles);
    markAiMemorySnapshotDirty({ chatId: 2, revision: 2, snapshot: "new-memory", files: aiFiles });
    expect(flushAiMemorySnapshots(aiFiles)).toBeTrue();
    writeAiMemoryFile.mockClear();

    deleteAiMemorySnapshot(2, 1, aiFiles);

    expect(deleteAiMemoryFile).not.toHaveBeenCalled();
    expect(aiMemoryCache.get(2)).toBe("new-memory");
    expect(deleteReplies).toEqual([{ type: "aiMemoryDeletedPersisted", chatId: 2, revision: 1 }]);
    expect(flushAiMemorySnapshots(aiFiles)).toBeTrue();
    expect(writeAiMemoryFile).not.toHaveBeenCalled();
  });

  test("reset 取消本领域 timer 并清空恢复态、dirty 与待删除集合", () => {
    markAiMemorySnapshotDirty({ chatId: 2, revision: 1, snapshot: "ai-two", files: aiFiles });
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
