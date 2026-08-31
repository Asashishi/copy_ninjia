import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersona } from "../../packages/config/persona";

describe("persona deployment input", () => {
  test("缺失与空白文件都安全地拒绝", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-persona-"));
    const path: string = join(directory, "persona.md");

    await expect(loadPersona(path)).rejects.toThrow(`${path}: $ must be a readable non-empty UTF-8 text file`);
    writeFileSync(path, " \n\t ", "utf8");
    await expect(loadPersona(path)).rejects.toThrow(`${path}: $ must be a readable non-empty UTF-8 text file`);
  });

  test("非空内容去掉边界空白后复用", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-persona-"));
    const path: string = join(directory, "persona.md");
    writeFileSync(path, "  stable persona  \n", "utf8");

    expect(await loadPersona(path)).toBe("stable persona");
  });

  test("非法 UTF-8 不得被替换字符掩盖", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-persona-"));
    const path: string = join(directory, "persona.md");
    writeFileSync(path, new Uint8Array([0xff]));

    await expect(loadPersona(path)).rejects.toThrow(
      `${path}: $ must be a readable non-empty UTF-8 text file`
    );
  });
});
