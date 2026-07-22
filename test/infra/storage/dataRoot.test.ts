import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeDataRoot } from "../../../src/infra/storage/dataRoot";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "data-root-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("runtime data root preflight", () => {
  test("递归创建尚不存在的嵌套目录并清理能力探针", async () => {
    const nested: string = join(testDir, "var", "lib", "copy-ninjia");

    await prepareRuntimeDataRoot(nested);

    expect(existsSync(nested)).toBeTrue();
    expect(readdirSync(nested)).toEqual([]);
  });

  test("普通文件占位时给出包含实际路径的可操作错误", async () => {
    const occupied: string = join(testDir, "not-a-directory");
    writeFileSync(occupied, "occupied");

    await expect(prepareRuntimeDataRoot(occupied)).rejects.toThrow(occupied);
    await expect(prepareRuntimeDataRoot(occupied)).rejects.toThrow("writable directory");
  });

  test("不可写与不支持 hard link 都在启动前 fail closed", async () => {
    const readOnly: string = join(testDir, "read-only");
    await expect(prepareRuntimeDataRoot(readOnly, {
      open: (async () => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }) as never,
    })).rejects.toThrow("permission denied");

    const noLinks: string = join(testDir, "no-hard-links");
    await expect(prepareRuntimeDataRoot(noLinks, {
      link: (async () => {
        const error = new Error("operation not supported") as NodeJS.ErrnoException;
        error.code = "ENOTSUP";
        throw error;
      }) as never,
    })).rejects.toThrow("hard links");
  });
});
