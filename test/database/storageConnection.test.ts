/**
 * 共享存储数据库的连接边界（packages/database/interact/connection.ts）。
 *
 * 这里守两件事：
 * 1. **缺库必须拒绝**。运行时只接受迁移脚本建好的数据库，绝不顺手创建一个空库
 *    ——那会让一次路径写错静默变成「全部黑白名单、群状态、问答凭空消失」，
 *    而进程照常起来（AGENTS.md「不为用户行为兜底」）。
 * 2. **写连接额外核对文件与父目录**。SQLite 写连接要维护 WAL/SHM 旁路文件，
 *    因此比只读连接多查一道父目录；两道检查的拒绝分支在
 *    test/libs/fileAccess.test.ts，这里只钉住写连接确实多走这一步。
 *
 * `enableStorageDatabaseWal` 是新库发布后的一次性动作，同样在这里覆盖：journal
 * 模式要真的写进库文件（干净关闭后 -wal/-shm 旁路文件会被回收，因此只能回读
 * PRAGMA，不能拿旁路文件在不在当证据）。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  test("数据库文件不存在时拒绝打开，且指明要先初始化", () => {
    const path: string = join(tempRoot(), "storage.sqlite");

    expect(() => openStorageDatabase({ path })).toThrow(
      `${path}: database file is missing; initialize current storage first.`
    );
    // 拒绝之后不得留下任何文件：顺手建一个空库等于把「路径写错了」变成
    // 「名单被清空了」，而两者在运行期看起来一模一样。
    expect(existsSync(path)).toBeFalse();
  });

  test("写连接额外核对文件与父目录，两者都可用时照常打开", () => {
    const path: string = join(tempRoot(), "storage.sqlite");
    createStorageDatabase(path);

    // requireWritableAccess 走的是 libs/fileAccess.ts 的两道 access 检查；
    // 拒绝分支（权限不足 / 路径不存在）由 test/libs/fileAccess.test.ts 覆盖，
    // 这里只钉住「写连接确实多查这一步，且齐备时不误伤」。
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
