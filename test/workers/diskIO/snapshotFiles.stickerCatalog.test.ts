import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("回归用例：键名恰好是 __proto__ 的条目照常恢复，不被原型 setter 吃掉", () => {
    // JSON.parse 会把 __proto__ 建成普通自有属性，写进 `{}` 时却会触发
    // Object.prototype 的 setter：条目没进对象、原型被改，那张贴纸通过了校验、
    // 被报告为已恢复，却在重新序列化的快照里彻底消失，描述永久丢失且无任何日志。
    mkdirSync(stickerDir, { recursive: true });
    // 只能写字面 JSON 文本：对象字面量里的 `__proto__:` 同样会被当成设原型，
    // 用 JSON.stringify 造出来的夹具压根不含这个键。
    writeFileSync(join(stickerDir, "pack_a.json"), [
      "{",
      "  \"version\": 1,",
      "  \"entries\": {",
      "    \"__proto__\": { \"emoji\": \"😼\", \"description\": \"原型键贴纸\" },",
      "    \"file-uid-1\": { \"emoji\": \"😂\", \"description\": \"普通贴纸\" }",
      "  },",
      "  \"summary\": null,",
      "  \"savedAt\": 1700000000000",
      "}",
    ].join("\n"));

    const result = recoverStickerCatalogs(["pack_a"]);

    const recovered: StickerCatalogSnapshot | undefined = parseRecovered(result, "pack_a");
    expect(Object.keys(recovered?.entries ?? {}).sort()).toEqual(["__proto__", "file-uid-1"]);
    expect(recovered?.entries["__proto__"]?.description).toBe("原型键贴纸");
    expect(recovered?.entries["file-uid-1"]?.description).toBe("普通贴纸");
  });

  test("缺少当前必填 summary 字段的文件不自动迁移", () => {
    mkdirSync(stickerDir, { recursive: true });
    writeFileSync(join(stickerDir, "pack_a.json"), JSON.stringify({ version: 1, entries: { "file-uid-1": { emoji: "😂", description: "旧条目" } }, savedAt: 0 }));
    expect(() => recoverStickerCatalogs(["pack_a"])).toThrow("current version=1 sticker catalog schema");
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

  test("损坏的 JSON 文件属于白名单内包时拒绝恢复并保持原始字节", () => {
    mkdirSync(stickerDir, { recursive: true });
    const path: string = join(stickerDir, "pack_a.json");
    const bytes: string = "{not valid json";
    writeFileSync(path, bytes);

    expect(() => recoverStickerCatalogs(["pack_a"])).toThrow("readable valid JSON document");
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  test("未知字段不在恢复时被重建丢弃", () => {
    mkdirSync(stickerDir, { recursive: true });
    const sourcePath: string = join(stickerDir, "pack_a.json");
    const bytes: string = JSON.stringify({
      version: 1,
      entries: {},
      summary: null,
      savedAt: 1,
      futureField: "must not disappear",
    });
    writeFileSync(sourcePath, bytes);

    expect(() => recoverStickerCatalogs(["pack_a"])).toThrow("current version=1 sticker catalog schema");
    expect(readFileSync(sourcePath, "utf8")).toBe(bytes);
  });

  test("非法贴纸包文件名不会被当作已下架孤儿静默删除", () => {
    mkdirSync(stickerDir, { recursive: true });
    const sourcePath: string = join(stickerDir, "bad-pack.json");
    const bytes: string = snapshot("文件名不合法但内容完整");
    writeFileSync(sourcePath, bytes);

    expect(() => recoverStickerCatalogs(["pack_a"])).toThrow("canonical <stickerPackShortName>.json form");
    expect(readFileSync(sourcePath, "utf8")).toBe(bytes);
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
