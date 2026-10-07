import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptFile } from "../../packages/config/promptFile";

/** 各用例独占的临时目录；afterEach 整棵删掉。 */
const tempDirs: string[] = [];

afterEach((): void => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** 开一个用例独占的临时目录并登记，返回其中尚未创建的提示词文件路径。 */
function promptPath(): string {
  const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-prompt-"));
  tempDirs.push(directory);
  return join(directory, "prompt.md");
}

describe("prompt file deployment input", () => {
  test("读不到与空白文件都安全地拒绝", async () => {
    const path: string = promptPath();

    await expect(loadPromptFile(path)).rejects.toThrow(`${path}: $ must be a readable non-empty UTF-8 text file`);
    await Bun.write(path, " \n\t ");
    await expect(loadPromptFile(path)).rejects.toThrow(`${path}: $ must be a readable non-empty UTF-8 text file`);
  });

  test("非空内容去掉边界空白后复用", async () => {
    const path: string = promptPath();
    await Bun.write(path, "  stable prompt  \n");

    expect(await loadPromptFile(path)).toBe("stable prompt");
  });

  test("非法 UTF-8 不得被替换字符掩盖", async () => {
    const path: string = promptPath();
    await Bun.write(path, new Uint8Array([0xff]));

    await expect(loadPromptFile(path)).rejects.toThrow(
      `${path}: $ must be a readable non-empty UTF-8 text file`
    );
  });
});
