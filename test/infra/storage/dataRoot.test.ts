import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeDataRoot } from "../../../packages/infra/storage/dataRoot";

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
    expect((statSync(nested).mode & 0o777) & ~0o750).toBe(0);
    expect(readdirSync(nested).sort()).toEqual(["config", "logs", "memory"]);
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
      dependencies: {
        open: (async () => {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }) as never,
      },
    })).rejects.toThrow("permission denied");

    const noLinks: string = join(testDir, "no-hard-links");
    await expect(prepareRuntimeDataRoot(noLinks, {
      dependencies: {
        link: (async () => {
          const error = new Error("operation not supported") as NodeJS.ErrnoException;
          error.code = "ENOTSUP";
          throw error;
        }) as never,
      },
    })).rejects.toThrow("hard links");
  });

  test("已有数据根权限宽于 0750 时 fail closed，且不会自动 chmod", async () => {
    const publicRoot: string = join(testDir, "public-root");
    await prepareRuntimeDataRoot(publicRoot);
    chmodSync(publicRoot, 0o755);

    await expect(prepareRuntimeDataRoot(publicRoot)).rejects.toThrow("mode 0755 is broader than 0750");
    expect(statSync(publicRoot).mode & 0o777).toBe(0o755);
  });

  test("敏感顶层目录沿用同一 owner/mode 门禁，0750 的共享只读 group 可用", async () => {
    const privateRoot: string = join(testDir, "private-root");
    await prepareRuntimeDataRoot(privateRoot);
    const memoryDir: string = join(privateRoot, "memory");
    chmodSync(memoryDir, 0o755);

    await expect(prepareRuntimeDataRoot(privateRoot)).rejects.toThrow(`${memoryDir} mode 0755`);
    expect(statSync(memoryDir).mode & 0o777).toBe(0o755);

    chmodSync(memoryDir, 0o750);
    await expect(prepareRuntimeDataRoot(privateRoot)).resolves.toBeUndefined();
  });

  test("目录 owner 与运行 uid 不一致时在写探针前拒绝", async () => {
    const wrongOwnerRoot: string = join(testDir, "wrong-owner-root");
    const currentUid: number = typeof process.getuid === "function" ? process.getuid() : 0;

    await expect(prepareRuntimeDataRoot(wrongOwnerRoot, {
      expectedOwnerUid: currentUid + 1,
    })).rejects.toThrow(`expected runtime uid ${currentUid + 1}`);
  });

  test("未显式配置数据根时可跳过权限门禁，但仍执行可写性探针", async () => {
    const projectRoot: string = join(testDir, "project-root");
    await prepareRuntimeDataRoot(projectRoot, { enforcePrivatePermissions: false });
    chmodSync(projectRoot, 0o755);

    await expect(prepareRuntimeDataRoot(projectRoot, {
      enforcePrivatePermissions: false,
    })).resolves.toBeUndefined();
    expect(readdirSync(projectRoot)).toEqual([]);
  });
});
