import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * mock.module 必须在任何真实 import 之前调用（理由同 test/workers/diskIO/
 * luckFiles.test.ts 的模块头注释）：snapshotFiles.ts 从 consts/paths 取
 * STICKER_MEMORY_DIR，指向项目真实的 memory/stickers/ 目录——单测里绝不能
 * 往那里写，整体重定向到临时目录。
 */
const stickerDir: string = mkdtempSync(join(tmpdir(), "sticker-catalog-test-"));
const realPaths = await import("../../../packages/consts/paths");
const { mock } = await import("bun:test");
mock.module("../../../packages/consts/paths", () => ({ ...realPaths, STICKER_MEMORY_DIR: stickerDir }));

const { recoverStickerCatalogs, writeStickerCatalogFile } = await import("../../../packages/workers/diskIO/snapshotFiles");
import type { StickerCatalogSnapshot } from "../../../packages/types";

/** 快照在管线上以序列化 JSON 文本流转（见 types/aiChat.ts 的
 *  AiStickerCatalogEvent.snapshot），写入接口也吃字符串。 */
function snapshot(description: string): string {
  const value: StickerCatalogSnapshot = { version: 1, entries: { "file-uid-1": { emoji: "😂", description } }, summary: "一包搞笑猫猫贴纸", savedAt: 1700000000000 };
  return JSON.stringify(value, null, 2);
}

/** recover 的返回值同为 JSON 文本，断言内容前解析回结构。 */
function parseRecovered(result: Map<string, string>, pack: string): StickerCatalogSnapshot | undefined {
  const json: string | undefined = result.get(pack);
  return json === undefined ? undefined : (JSON.parse(json) as StickerCatalogSnapshot);
}

beforeEach(() => {
  rmSync(stickerDir, { recursive: true, force: true });
});

describe("workers/diskIO/snapshotFiles recoverStickerCatalogs 白名单对账", () => {
  test("白名单里的包正常恢复（含整包简介）", () => {
    writeStickerCatalogFile("pack_a", snapshot("一只猫大笑"));
    const result = recoverStickerCatalogs(["pack_a", "pack_b"]);
    expect(result.size).toBe(1);
    expect(parseRecovered(result, "pack_a")?.entries["file-uid-1"]?.description).toBe("一只猫大笑");
    expect(parseRecovered(result, "pack_a")?.summary).toBe("一包搞笑猫猫贴纸");
  });

  test("缺少当前必填 summary 字段的文件不自动迁移", () => {
    mkdirSync(stickerDir, { recursive: true });
    writeFileSync(join(stickerDir, "pack_a.json"), JSON.stringify({ version: 1, entries: { "file-uid-1": { emoji: "😂", description: "旧条目" } }, savedAt: 0 }));
    expect(() => recoverStickerCatalogs(["pack_a"])).toThrow("migrate it manually before starting the bot");
    expect(existsSync(join(stickerDir, "pack_a.json"))).toBe(true);
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

  test("损坏的 JSON 文件即使属于白名单内的包，也用唯一 .corrupt 名隔离而不是当孤儿删除", () => {
    mkdirSync(stickerDir, { recursive: true });
    writeFileSync(join(stickerDir, "pack_a.json"), "{not valid json");
    const result = recoverStickerCatalogs(["pack_a"]);
    expect(result.has("pack_a")).toBe(false);
    expect(readdirSync(stickerDir).filter((name: string): boolean =>
      /^pack_a\.json\.\d+\.[^.]+\.corrupt$/.test(name)
    )).toHaveLength(1);
  });

  test("同一路径连续两次损坏会保留两份原始字节，不覆盖旧隔离证据", () => {
    mkdirSync(stickerDir, { recursive: true });
    const sourcePath: string = join(stickerDir, "pack_a.json");
    writeFileSync(sourcePath, "first broken bytes");
    recoverStickerCatalogs(["pack_a"]);
    writeFileSync(sourcePath, "second broken bytes");
    recoverStickerCatalogs(["pack_a"]);

    const quarantinedNames: string[] = readdirSync(stickerDir)
      .filter((name: string): boolean =>
        /^pack_a\.json\.\d+\.[^.]+\.corrupt$/.test(name)
      );
    expect(quarantinedNames).toHaveLength(2);
    expect(new Set(quarantinedNames.map((name: string): string =>
      readFileSync(join(stickerDir, name), "utf8")
    ))).toEqual(new Set(["first broken bytes", "second broken bytes"]));
    expect(existsSync(sourcePath)).toBe(false);
  });

  test("空白名单时所有持久化包都被当孤儿清掉", () => {
    writeStickerCatalogFile("pack_a", snapshot("a"));
    writeStickerCatalogFile("pack_b", snapshot("b"));
    const result = recoverStickerCatalogs([]);
    expect(result.size).toBe(0);
    expect(existsSync(join(stickerDir, "pack_a.json"))).toBe(false);
    expect(existsSync(join(stickerDir, "pack_b.json"))).toBe(false);
  });

  test("白名单不可用（null）：照常读进内存，但一个文件都不动", () => {
    // 空数组表示「一个包都不该留」，null 表示「这一轮对该留哪些没有发言权」。
    // 两者绝不能混为一谈——传空数组会把 memory/stickers/ 整个清空。
    writeStickerCatalogFile("pack_a", snapshot("a"));
    writeStickerCatalogFile("pack_b", snapshot("b"));

    const result = recoverStickerCatalogs(null);
    expect(result.size).toBe(2);
    expect(parseRecovered(result, "pack_a")?.entries["file-uid-1"]?.description).toBe("a");
    expect(existsSync(join(stickerDir, "pack_a.json"))).toBe(true);
    expect(existsSync(join(stickerDir, "pack_b.json"))).toBe(true);
  });

  test("白名单不可用时，读不动的文件既不隔离也不拒绝启动", () => {
    writeStickerCatalogFile("good_pack", snapshot("好的"));
    mkdirSync(stickerDir, { recursive: true });
    writeFileSync(join(stickerDir, "broken_json.json"), "{not valid json");
    // 形状不认识：正常模式下这是「手动迁移后再启动」的硬停机信号，降级模式下
    // 不能让一份写坏的白名单顺带把它升级成拒绝启动。
    writeFileSync(join(stickerDir, "old_schema.json"), JSON.stringify({ version: 0 }));

    const originalConsoleError = console.error;
    console.error = (): void => {};
    let result: Map<string, string>;
    try {
      result = recoverStickerCatalogs(null);
    } finally {
      console.error = originalConsoleError;
    }

    expect([...result.keys()]).toEqual(["good_pack"]);
    // 改名同样是破坏性的：降级这一轮本就不该动盘。
    expect(existsSync(join(stickerDir, "broken_json.json"))).toBe(true);
    expect(existsSync(join(stickerDir, "broken_json.json.corrupt"))).toBe(false);
    expect(existsSync(join(stickerDir, "old_schema.json"))).toBe(true);
  });
});
