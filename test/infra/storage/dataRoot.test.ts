import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stats } from "node:fs";
import { prepareRuntimeDataRoot } from "../../../packages/infra/storage/dataRoot";
import { IDENTITY_DATABASE_DIRECTORY_MODE } from "../../../packages/consts/identityStorage";

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
    expect((statSync(nested).mode & 0o777) & ~0o755).toBe(0);
    expect(readdirSync(nested).sort()).toEqual(["database", "logs", "memory"]);
    expect(existsSync(join(nested, "config"))).toBeFalse();
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

  test("数据根拿到 group/other 写位时 fail closed，且不会自动 chmod", async () => {
    const publicRoot: string = join(testDir, "public-root");
    await prepareRuntimeDataRoot(publicRoot);
    // 默认 umask 建出来的 0755 是放行的：这道闸拦的是别的账号能不能**改**
    // 运行状态，不是能不能读（读侧的取舍见 RUNTIME_DATA_ROOT_MAX_MODE 的 JSDoc）。
    chmodSync(publicRoot, 0o755);
    await expect(prepareRuntimeDataRoot(publicRoot)).resolves.toBeUndefined();

    chmodSync(publicRoot, 0o775);
    await expect(prepareRuntimeDataRoot(publicRoot)).rejects.toThrow("mode 0775 is broader than 0755");
    // 拒绝之后原样保留，绝不替部署方 chmod。
    expect(statSync(publicRoot).mode & 0o777).toBe(0o775);
  });

  test("敏感顶层目录沿用同一 owner/mode 门禁：读放行、写拒绝", async () => {
    const privateRoot: string = join(testDir, "private-root");
    await prepareRuntimeDataRoot(privateRoot);
    const memoryDir: string = join(privateRoot, "memory");
    chmodSync(memoryDir, 0o775);

    await expect(prepareRuntimeDataRoot(privateRoot)).rejects.toThrow(`${memoryDir} mode 0775`);
    expect(statSync(memoryDir).mode & 0o777).toBe(0o775);

    // 0755 与更严格的 0750 都放行。
    chmodSync(memoryDir, 0o755);
    await expect(prepareRuntimeDataRoot(privateRoot)).resolves.toBeUndefined();
    chmodSync(memoryDir, 0o750);
    await expect(prepareRuntimeDataRoot(privateRoot)).resolves.toBeUndefined();
  });

  test("database 允许迁移脚本建立的协作组写入权限，其他敏感目录仍拒绝", async () => {
    const privateRoot: string = join(testDir, "collaborative-database-root");
    await prepareRuntimeDataRoot(privateRoot);
    const databaseDir: string = join(privateRoot, "database");
    chmodSync(databaseDir, IDENTITY_DATABASE_DIRECTORY_MODE);

    await expect(prepareRuntimeDataRoot(privateRoot)).resolves.toBeUndefined();

    const memoryDir: string = join(privateRoot, "memory");
    chmodSync(memoryDir, 0o770);
    await expect(prepareRuntimeDataRoot(privateRoot)).rejects.toThrow(
      `${memoryDir} mode 0770 is broader than 0755`
    );
  });

  test("database 可由同一有效协作组的部署账号持有", async () => {
    const privateRoot: string = join(testDir, "group-owned-database-root");
    await prepareRuntimeDataRoot(privateRoot);
    const databaseDir: string = join(privateRoot, "database");
    chmodSync(databaseDir, IDENTITY_DATABASE_DIRECTORY_MODE);
    const currentUid: number = typeof process.getuid === "function" ? process.getuid() : 0;
    const databaseGid: number = statSync(databaseDir).gid;
    const spoofDatabaseOwner = (async (path: string): Promise<Stats> => {
      const stats: Stats = await lstat(path);
      if (path === databaseDir) {
        Object.defineProperty(stats, "uid", { value: currentUid + 1 });
      }
      return stats;
    }) as never;

    await expect(prepareRuntimeDataRoot(privateRoot, {
      dependencies: { lstat: spoofDatabaseOwner },
      expectedGroupGids: [databaseGid],
      expectedOwnerUid: currentUid,
    })).resolves.toBeUndefined();
    await expect(prepareRuntimeDataRoot(privateRoot, {
      dependencies: { lstat: spoofDatabaseOwner },
      expectedGroupGids: [],
      expectedOwnerUid: currentUid,
    })).rejects.toThrow("correct the owner or writable deployment group");
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

  test("数据根 symlink 即使指向可写私有目录也 fail closed", async () => {
    const target: string = join(testDir, "linked-root-target");
    const linkedRoot: string = join(testDir, "linked-root");
    mkdirSync(target, { mode: 0o750 });
    symlinkSync(target, linkedRoot, "dir");

    await expect(prepareRuntimeDataRoot(linkedRoot)).rejects.toThrow("symbolic link");
    await expect(prepareRuntimeDataRoot(linkedRoot, {
      enforcePrivatePermissions: false,
    })).rejects.toThrow("symbolic link");
    expect(readdirSync(target)).toEqual([]);
  });

  test("database、memory 或 logs 敏感子目录不能用 symlink 逃出数据根", async () => {
    const root: string = join(testDir, "real-root");
    await prepareRuntimeDataRoot(root);
    const externalTarget: string = join(testDir, "external-memory");
    mkdirSync(externalTarget, { mode: 0o750 });
    const memoryPath: string = join(root, "memory");
    rmSync(memoryPath, { recursive: true });
    symlinkSync(externalTarget, memoryPath, "dir");

    await expect(prepareRuntimeDataRoot(root)).rejects.toThrow(
      `${memoryPath} is a symbolic link`
    );
    await expect(prepareRuntimeDataRoot(root, {
      enforcePrivatePermissions: false,
    })).rejects.toThrow(`${memoryPath} is a symbolic link`);
    expect(readdirSync(externalTarget)).toEqual([]);
  });
});
