/**
 * 共享存储数据库的连接边界（packages/database/interact/connection.ts）。
 *
 * 覆盖两件事：
 * 1. 缺库必须拒绝：运行时只接受迁移脚本建好的数据库，不顺手创建空库
 *    （AGENTS.md「不为用户行为兜底」）。
 * 2. 写连接额外核对文件与父目录：SQLite 写连接要维护 WAL/SHM 旁路文件，
 *    比只读连接多查一道父目录；两道检查的拒绝分支在 test/libs/fileAccess.test.ts，
 *    这里只验证写连接确实多走这一步。
 *
 * `enableStorageDatabaseWal` 是新库发布后的一次性动作，同样在这里覆盖：journal
 * 模式写进库文件；干净关闭后 -wal/-shm 旁路文件会被回收，因此回读 PRAGMA 判定，
 * 不看旁路文件是否存在。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import { createStorageDatabase } from
  "../../packages/database/interact/migration";
import type { StorageDatabase } from "../../packages/types/storageDatabase";

let temporaryRoot: string | null = null;

function tempRoot(): string {
  temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-storage-connection-"));
  return temporaryRoot;
}

afterEach((): void => {
  if (temporaryRoot === null) return;
  rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe("共享存储数据库连接", () => {
  test("建库目标是悬空软链接时拒绝创建，不顺着链接在目标处建库", () => {
    const root: string = tempRoot();
    const path: string = join(root, "storage.sqlite");
    const target: string = join(root, "elsewhere.sqlite");
    symlinkSync(target, path);
    expect(() => createStorageDatabase(path)).toThrow("target already exists; refusing to overwrite it.");
    expect(existsSync(target)).toBe(false);
  });

  test("数据库文件不存在时拒绝打开，且指明要先初始化", () => {
    const path: string = join(tempRoot(), "storage.sqlite");

    expect(() => openStorageDatabase({ path })).toThrow(
      `${path}: database file is missing; initialize current storage first.`
    );
    // 拒绝之后不得顺手创建空库。
    expect(existsSync(path)).toBeFalse();
  });

  test("写连接额外核对文件与父目录，两者都可用时照常打开", () => {
    const path: string = join(tempRoot(), "storage.sqlite");
    createStorageDatabase(path);

    const database: StorageDatabase = openStorageDatabase({
      path,
      requireWritableAccess: true,
    });
    try {
      expect(database.$client).toBeDefined();
    } finally {
      closeStorageDatabase(database);
    }
  });

  test("enableStorageDatabaseWal 打开 WAL 并归还连接", () => {
    const path: string = join(tempRoot(), "storage.sqlite");
    createStorageDatabase(path);

    enableStorageDatabaseWal(path);

    const database: StorageDatabase = openStorageDatabase({ path });
    try {
      const [mode] = database.$client
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode;")
        .all();
      expect(mode?.journal_mode.toLowerCase()).toBe("wal");
    } finally {
      closeStorageDatabase(database);
    }
  });

  test("只读连接可以打开既有库", () => {
    const path: string = join(tempRoot(), "storage.sqlite");
    createStorageDatabase(path);

    const database: StorageDatabase = openStorageDatabase({ path, readonly: true });
    try {
      expect(database.$client).toBeDefined();
    } finally {
      closeStorageDatabase(database);
    }
  });
});
