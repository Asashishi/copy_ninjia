import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersona } from "../../packages/config/persona";

describe("persona deployment input", () => {
  test("缺失与空白文件都安全地拒绝", () => {
    const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-persona-"));
    const path: string = join(directory, "persona.md");

    expect(() => loadPersona(path)).toThrow(`${path}: $ must be a readable non-empty UTF-8 text file`);
    writeFileSync(path, " \n\t ", "utf8");
    expect(() => loadPersona(path)).toThrow(`${path}: $ must be a readable non-empty UTF-8 text file`);
  });

  test("非空内容去掉边界空白后复用", () => {
    const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-persona-"));
    const path: string = join(directory, "persona.md");
    writeFileSync(path, "  stable persona  \n", "utf8");

    expect(loadPersona(path)).toBe("stable persona");
  });
});
