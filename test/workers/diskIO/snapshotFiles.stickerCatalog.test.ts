import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * mock.module 必须在任何真实 import 之前调用（理由同 test/workers/diskIO/
 * luckFiles.test.ts 的模块头注释）：snapshotFiles.ts 从 consts/paths 取
 * STICKER_MEMORY_DIR，指向项目真实的 memory/stickers/ 目录——单测里绝不能
 * 往那里写，整体重定向到临时目录。
 */
const stickerDir: string = mkdtempSync(join(tmpdir(), "sticker-catalog-test-"));
const realPaths = await import("../../../src/consts/paths");
const { mock } = await import("bun:test");
mock.module("../../../src/consts/paths", () => ({ ...realPaths, STICKER_MEMORY_DIR: stickerDir }));

const { recoverStickerCatalogs, writeStickerCatalogFile } = await import("../../../src/workers/diskIO/snapshotFiles");
import type { StickerCatalogSnapshot } from "../../../src/types";

function snapshot(description: string): StickerCatalogSnapshot {
  return { version: 1, entries: { "file-uid-1": { emoji: "😂", description } }, savedAt: 1700000000000 };
}

beforeEach(() => {
  rmSync(stickerDir, { recursive: true, force: true });
});

describe("workers/diskIO/snapshotFiles recoverStickerCatalogs 白名单对账", () => {
  test("白名单里的包正常恢复", () => {
    writeStickerCatalogFile("pack_a", snapshot("一只猫大笑"));
    const result = recoverStickerCatalogs(["pack_a", "pack_b"]);
    expect(result.size).toBe(1);
    expect(result.get("pack_a")?.entries["file-uid-1"]?.description).toBe("一只猫大笑");
  });

  test("白名单已经不包含的包视为孤儿：不载入内存，且磁盘文件被删除", () => {
    writeStickerCatalogFile("removed_pack", snapshot("过时的贴纸"));
    const filePath = join(stickerDir, "removed_pack.json");
    expect(existsSync(filePath)).toBe(true);

    const result = recoverStickerCatalogs(["pack_a"]); // 白名单里没有 removed_pack
    expect(result.has("removed_pack")).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });

  test("孤儿清理与正常恢复互不影响，混合场景各自正确处理", () => {
    writeStickerCatalogFile("kept_pack", snapshot("保留的包"));
    writeStickerCatalogFile("orphan_pack", snapshot("被移除的包"));

    const result = recoverStickerCatalogs(["kept_pack"]);
    expect(result.size).toBe(1);
    expect(result.has("kept_pack")).toBe(true);
    expect(existsSync(join(stickerDir, "kept_pack.json"))).toBe(true);
    expect(existsSync(join(stickerDir, "orphan_pack.json"))).toBe(false);
  });

  test("损坏的 JSON 文件即使属于白名单内的包，也按原逻辑隔离为 .corrupt 而不是当孤儿删除", () => {
    mkdirSync(stickerDir, { recursive: true });
    writeFileSync(join(stickerDir, "pack_a.json"), "{not valid json");
    const result = recoverStickerCatalogs(["pack_a"]);
    expect(result.has("pack_a")).toBe(false);
    expect(existsSync(join(stickerDir, "pack_a.json.corrupt"))).toBe(true);
  });

  test("空白名单时所有持久化包都被当孤儿清掉", () => {
    writeStickerCatalogFile("pack_a", snapshot("a"));
    writeStickerCatalogFile("pack_b", snapshot("b"));
    const result = recoverStickerCatalogs([]);
    expect(result.size).toBe(0);
    expect(existsSync(join(stickerDir, "pack_a.json"))).toBe(false);
    expect(existsSync(join(stickerDir, "pack_b.json"))).toBe(false);
  });
});
