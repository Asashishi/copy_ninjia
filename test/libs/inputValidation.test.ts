import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readJsonInput,
  readUtf8TextInput,
} from "../../packages/libs/inputValidation";

describe("Bun 原生不可信输入读取", () => {
  test("JSON 读取拒绝非法 UTF-8，不把替换字符交给解析器", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-json-input-"));
    const path: string = join(directory, "input.json");
    writeFileSync(path, new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]));

    await expect(readJsonInput(path)).rejects.toThrow(
      `${path}: $ must be a readable valid JSON document.`
    );
  });

  test("读取前被删除的文件明确失败，不返回旧 Blob 内容", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-text-input-"));
    const path: string = join(directory, "input.txt");
    writeFileSync(path, "ready", "utf8");
    rmSync(path);

    await expect(readUtf8TextInput(path)).rejects.toThrow();
  });
});
