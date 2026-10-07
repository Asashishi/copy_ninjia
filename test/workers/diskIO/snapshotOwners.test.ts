import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";

const recoveredStickers: Map<string, string> = new Map<string, string>([["pack_one", "sticker-one"]]);
const recoverStickerCatalogs = mock((_packs: readonly string[]): Map<string, string> => new Map(recoveredStickers));
const writeStickerCatalogFile = mock((_pack: string, _snapshot: string): void => {});
const stickerFiles = { write: writeStickerCatalogFile };

const {
  adoptStickerCatalogSnapshots,
  flushStickerCatalogs,
  markStickerCatalogSnapshotDirty,
} = await import("../../../packages/workers/diskIO/stickerCatalogFiles");
const {
  inspectStickerCatalogs,
  maintainStickerCatalogFiles,
  writeStickerCatalogFile: writeStickerCatalogFileToDisk,
} = await import("../../../packages/workers/diskIO/snapshotFiles");
const { SNAPSHOT_FLUSH_INTERVAL_MS } =
  await import("../../../packages/consts/diskIO/snapshots");
const { STICKER_MEMORY_DIR } =
  await import("../../../packages/consts/paths");

/**
 * 清空隔离数据根下的贴纸目录。
 *
 * 三阶段恢复用例自己写入基线，定时 flush 用例经模块默认依赖写入；inspect 严格解码
 * 目录里的每一个文件（白名单外的孤儿也先解码），用例之间不得留下残留文件。
 */
function clearStickerDirectory(): void {
  rmSync(STICKER_MEMORY_DIR, { recursive: true, force: true });
}

/** 一份合法的贴纸目录快照文本，供三阶段恢复用例写进真实目录。 */
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
 * 启动恢复的测试编排：与生产 adoptStickerCatalogSnapshots 一样把只读扫描的结果整体发布进
 * owner 缓存（见 workers/diskIO/startup.ts）；这里用注入的假结果，不碰真实目录。
 */
function hydrateStickerCatalogs(activePacks: readonly string[]): Map<string, string> {
  hydrateStickerCatalogCache(recoverStickerCatalogs(activePacks));
  return stickerCatalogCache;
}

beforeEach(() => {
  resetStickerCatalogCache();
  clearStickerDirectory();
  recoverStickerCatalogs.mockClear();
  writeStickerCatalogFile.mockClear();
});

afterEach(() => {
  resetStickerCatalogCache();
  clearStickerDirectory();
});

describe("Disk I/O sticker catalog snapshot owner", () => {
  test("贴纸目录的三阶段启动 API 走真实目录：inspect 只读、adopt 才发布、maintenance 收尾", async () => {
    // 生产启动经 workers/diskIO/startup.ts 依次调用这三个函数；diskIOWorker.test.ts
    // 把它们整份 mock 掉，真实目录上的行为由本用例覆盖。
    writeStickerCatalogFileToDisk("pack_one", stickerSnapshotJson("恢复出来的目录"));
    stickerCatalogCache.set("stale_pack", "stale-sticker");

    const inspection = await inspectStickerCatalogs(["pack_one"]);
    // 第一阶段只读：adopt 之前 owner 缓存原封不动。
    expect(stickerCatalogCache.get("stale_pack")).toBe("stale-sticker");
    expect(inspection.snapshots.get("pack_one")).toBe(stickerSnapshotJson("恢复出来的目录"));

    expect(adoptStickerCatalogSnapshots(inspection)).toBe(stickerCatalogCache);
    // 整体替换：adopt 之后旧 owner 内容不残留。
    expect(stickerCatalogCache.has("stale_pack")).toBeFalse();
    expect(stickerCatalogCache.get("pack_one")).toBe(stickerSnapshotJson("恢复出来的目录"));

    await expect(maintainStickerCatalogFiles(inspection)).resolves.toBeUndefined();
  });

  test("dirty 项的快照在落盘前消失时只摘标记，不再写盘", () => {
    markStickerCatalogSnapshotDirty("pack_gone", "sticker-gone", 1);
    stickerCatalogCache.delete("pack_gone");
    flushStickerCatalogs(stickerFiles);
    expect(dirtyStickerPacks.size).toBe(0);
    expect(writeStickerCatalogFile).not.toHaveBeenCalled();
  });

  test("markDirty 排的定时 flush 到点后真的落盘并交回 timer 槽", () => {
    jest.useFakeTimers();
    try {
      // 定时 flush 走模块默认依赖，真实写进贴纸目录，内容是合法的快照 JSON（owner 缓存里存的是序列化好的文本）。
      markStickerCatalogSnapshotDirty("pack_two", stickerSnapshotJson("定时落盘"), 1);
      expect(stickerFlushState.timer).not.toBeNull();
      // 重复 markDirty 不另排一条：定时器槽只有一个。
      markStickerCatalogSnapshotDirty("pack_three", stickerSnapshotJson("同一拍"), 1);

      jest.advanceTimersByTime(SNAPSHOT_FLUSH_INTERVAL_MS);

      expect(stickerFlushState.timer).toBeNull();
      expect(dirtyStickerPacks).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("hydrate 整体替换旧状态，markDirty/flush 按快照写盘并交回 timer", () => {
    stickerCatalogCache.set("stale_pack", "stale-sticker");
    dirtyStickerPacks.add("stale_pack");

    expect(hydrateStickerCatalogs(["pack_one"])).toEqual(recoveredStickers);
    expect(dirtyStickerPacks).toHaveLength(0);

    markStickerCatalogSnapshotDirty("pack_two", "sticker-two", 1);
    expect(stickerFlushState.timer).not.toBeNull();

    flushStickerCatalogs(stickerFiles);
    expect(writeStickerCatalogFile).toHaveBeenCalledWith("pack_two", "sticker-two");
    expect(dirtyStickerPacks).toHaveLength(0);
    expect(stickerFlushState.timer).toBeNull();
  });

  test("flush 失败保留状态并自动重排，成功重试后清理", () => {
    const errorSpy = spyOn(console, "error").mockImplementation((): void => {});
    try {
      writeStickerCatalogFile.mockImplementationOnce((): void => { throw new Error("sticker write failed"); });

      markStickerCatalogSnapshotDirty("pack_two", "sticker-two", 1);
      expect(flushStickerCatalogs(stickerFiles)).toBeFalse();
      expect(dirtyStickerPacks.has("pack_two")).toBeTrue();
      expect(stickerFlushState.timer).not.toBeNull();

      expect(flushStickerCatalogs(stickerFiles)).toBeTrue();
      expect(dirtyStickerPacks).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("reset 取消本领域 timer 并清空恢复态与 dirty 集合", () => {
    markStickerCatalogSnapshotDirty("pack_two", "sticker-two", 1);

    resetStickerCatalogCache();

    expect(stickerCatalogCache).toHaveLength(0);
    expect(dirtyStickerPacks).toHaveLength(0);
    expect(stickerFlushState.timer).toBeNull();
  });
});
