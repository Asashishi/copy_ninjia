import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
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
const aiFiles = { write: writeAiMemoryFile, delete: deleteAiMemoryFile };
const stickerFiles = { write: writeStickerCatalogFile };
const deleteReplies: AiMemoryDeletedPersistedReply[] = [];
const persistedReplies: AiMemoryPersistedReply[] = [];

const {
  deleteAiMemorySnapshot,
  configureAiMemoryDeletePersistedReply,
  configureAiMemoryPersistedReply,
  flushAiMemorySnapshots,
  markAiMemorySnapshotDirty,
} = await import("../../../packages/workers/diskIO/aiMemoryFiles");
const {
  adoptStickerCatalogSnapshots,
  flushStickerCatalogs,
  inspectStickerCatalogSnapshots,
  maintainStickerCatalogSnapshots,
  markStickerCatalogSnapshotDirty,
} = await import("../../../packages/workers/diskIO/stickerCatalogFiles");
const {
  aiMemoryCache,
  hydrateAiMemoryCache,
  aiMemoryFlushState,
  aiMemoryOperations,
  aiMemoryRevisions,
  deletedAiMemoryChats,
  dirtyChats,
  forgetAiMemoryChat,
  resetAiMemoryCache,
} = await import("../../../packages/cache/workers/diskIO/snapshots");
const { writeStickerCatalogFile: writeStickerCatalogFileToDisk } =
  await import("../../../packages/workers/diskIO/snapshotFiles");
const { SNAPSHOT_FLUSH_INTERVAL_MS } =
  await import("../../../packages/consts/diskIO/snapshots");
const { STICKER_MEMORY_DIR } = await import("../../../packages/consts/paths");

/**
 * 清空隔离数据根下的贴纸目录。
 *
 * 本文件里有两个用例会真的落盘：三阶段恢复那条自己写入基线，定时 flush 那条经
 * 模块默认依赖写入。inspect 会严格解码目录里的**每一个**文件（白名单外的算孤儿
 * 也要先解码），所以任何跨用例残留都会让随机执行序变成偶发失败。
 */
function clearStickerDirectory(): void {
  rmSync(STICKER_MEMORY_DIR, { recursive: true, force: true });
}

/** 一份合法的 version=1 贴纸目录快照文本，供三阶段恢复用例写进真实目录。 */
function stickerSnapshotJson(description: string): string {
  return JSON.stringify({
    version: 1,
    entries: { "file-uid-1": { emoji: "😂", description } },
    summary: "一包搞笑猫猫贴纸",
    savedAt: 1_700_000_000_000,
  }, null, 2);
}

const {
  dirtyStickerPacks,
  hydrateStickerCatalogCache,
  resetStickerCatalogCache,
  stickerCatalogCache,
  stickerFlushState,
} = await import("../../../packages/cache/workers/diskIO/stickers");

/**
 * 启动恢复的测试编排：生产在 adoptAiMemorySnapshots / adoptStickerCatalogSnapshots
 * 里做同一件事——把只读扫描的结果整体发布进 owner 缓存（见
 * workers/diskIO/startup.ts）。这里用注入的假 files 产出那份结果，好在不碰真实
 * 目录的前提下验证 owner 的替换语义。
 */
function hydrateAiMemorySnapshots(): Map<number, string> {
  hydrateAiMemoryCache(recoverAiMemories());
  return aiMemoryCache;
}

function hydrateStickerCatalogs(activePacks: readonly string[]): Map<string, string> {
  hydrateStickerCatalogCache(recoverStickerCatalogs(activePacks));
  return stickerCatalogCache;
}

beforeEach(() => {
  resetAiMemoryCache();
  resetStickerCatalogCache();
  clearStickerDirectory();
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
  resetAiMemoryCache();
  resetStickerCatalogCache();
  clearStickerDirectory();
});

describe("Disk I/O snapshot domain owners", () => {
  test("贴纸目录的三阶段启动 API 走真实目录：inspect 只读、adopt 才发布、maintenance 收尾", async () => {
    // 生产启动只走这三个函数（见 workers/diskIO/startup.ts），此前它们在
    // diskIOWorker.test.ts 里被整份 mock 掉，一行都没真跑过。
    writeStickerCatalogFileToDisk("pack_one", stickerSnapshotJson("恢复出来的目录"));
    stickerCatalogCache.set("stale_pack", "stale-sticker");

    const inspection = await inspectStickerCatalogSnapshots(["pack_one"]);
    // 第一阶段只读：owner 缓存在 adopt 之前必须原封不动。
    expect(stickerCatalogCache.get("stale_pack")).toBe("stale-sticker");
    expect(inspection.snapshots.get("pack_one")).toBe(stickerSnapshotJson("恢复出来的目录"));

    expect(adoptStickerCatalogSnapshots(inspection)).toBe(stickerCatalogCache);
    // 整体替换：adopt 之后旧 owner 内容不得残留。
    expect(stickerCatalogCache.has("stale_pack")).toBeFalse();
    expect(stickerCatalogCache.get("pack_one")).toBe(stickerSnapshotJson("恢复出来的目录"));

    expect(() => maintainStickerCatalogSnapshots(inspection)).not.toThrow();
  });

  test("markDirty 排的定时 flush 到点后真的落盘并交回 timer 槽", () => {
    jest.useFakeTimers();
    try {
      // 定时 flush 走的是模块默认依赖，也就是真的写进贴纸目录；因此内容必须是
      // 合法的快照 JSON——owner 缓存里存的本来就是序列化好的文本，随手塞一个
      // 非 JSON 串会给同一目录留下一份下一次 inspect 必然拒绝的孤儿文件。
      markStickerCatalogSnapshotDirty("pack_two", stickerSnapshotJson("定时落盘"));
      expect(stickerFlushState.timer).not.toBeNull();
      // 重复 markDirty 不另排一条：定时器槽只有一个。
      markStickerCatalogSnapshotDirty("pack_three", stickerSnapshotJson("同一拍"));

      jest.advanceTimersByTime(SNAPSHOT_FLUSH_INTERVAL_MS);

      expect(stickerFlushState.timer).toBeNull();
      expect(dirtyStickerPacks).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("hydrate 整体替换旧状态，AI 与贴纸 markDirty/flush 使用独立 timer", () => {
    aiMemoryCache.set(999, "stale-ai");
    dirtyChats.add(999);
    stickerCatalogCache.set("stale_pack", "stale-sticker");
    dirtyStickerPacks.add("stale_pack");

    expect(hydrateAiMemorySnapshots()).toEqual(recoveredAi);
    expect(hydrateStickerCatalogs(["pack_one"])).toEqual(recoveredStickers);
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
    hydrateAiMemorySnapshots();
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

  test("回归：teardown 后 forgetAiMemoryChat 让重新启用的 revision 1 不再被当成迟到消息", () => {
    hydrateAiMemorySnapshots();
    // 旧一代写到 revision 13，teardown 的 purge 用 14 删掉。
    for (let revision: number = 1; revision <= 13; revision++) {
      markAiMemorySnapshotDirty({ chatId: 2, revision, snapshot: `memory-${revision}`, files: aiFiles });
    }
    deleteAiMemorySnapshot(2, 14, aiFiles);
    expect(aiMemoryRevisions.get(2)).toBe(14);

    // 主线程 teardown 把自己的计数器归零，Worker 侧必须同一时刻丢掉水位线。
    forgetAiMemoryChat(2);
    expect(aiMemoryRevisions.has(2)).toBeFalse();
    expect(aiMemoryOperations.has(2)).toBeFalse();

    // 重新入群/重新授权后的第一份快照：没有这条回收路径时它会被静默丢弃，
    // 一直丢到 revision 爬过 14 为止（期间进程重启即全丢，且零日志）。
    markAiMemorySnapshotDirty({ chatId: 2, revision: 1, snapshot: "fresh-memory", files: aiFiles });
    expect(aiMemoryCache.get(2)).toBe("fresh-memory");
    expect(flushAiMemorySnapshots(aiFiles)).toBeTrue();
    expect(writeAiMemoryFile).toHaveBeenLastCalledWith(2, "fresh-memory");
  });

  test("reset 取消本领域 timer 并清空恢复态、dirty 与待删除集合", () => {
    markAiMemorySnapshotDirty({ chatId: 2, revision: 1, snapshot: "ai-two", files: aiFiles });
    markStickerCatalogSnapshotDirty("pack_two", "sticker-two");
    deletedAiMemoryChats.add(3);

    resetAiMemoryCache();
    resetStickerCatalogCache();

    expect(aiMemoryCache).toHaveLength(0);
    expect(dirtyChats).toHaveLength(0);
    expect(deletedAiMemoryChats).toHaveLength(0);
    expect(aiMemoryFlushState.timer).toBeNull();
    expect(stickerCatalogCache).toHaveLength(0);
    expect(dirtyStickerPacks).toHaveLength(0);
    expect(stickerFlushState.timer).toBeNull();
  });
});
