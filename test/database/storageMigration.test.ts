/**
 * 新库创建与迁移谱系读取（packages/database/interact/migration.ts）：已存在的目标拒绝
 * 覆盖；`__drizzle_migrations` 里的时间戳或哈希形态不对时按未知历史拒绝。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStorageDatabase, openStorageDatabase } from "../../packages/database/interact/connection";
import {
  createStorageDatabase,
  readStorageDatabaseMigrationJournal,
} from "../../packages/database/interact/migration";
import type { StorageDatabase, StorageDatabaseMigrationJournalEntry } from "../../packages/types/storageDatabase";

let temporaryRoot: string | null = null;

function tempRoot(): string {
  temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-storage-migration-"));
  return temporaryRoot;
}

afterEach((): void => {
  if (temporaryRoot === null) return;
  rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

/** 建一个新库，按 statement 改写迁移记录后读取谱系。 */
function journalAfter(statement: string | null): () => readonly StorageDatabaseMigrationJournalEntry[] {
  const path: string = join(tempRoot(), "storage.sqlite");
  createStorageDatabase(path);
  return (): readonly StorageDatabaseMigrationJournalEntry[] => {
    const database: StorageDatabase = openStorageDatabase({ path });
    try {
      if (statement !== null) database.$client.run(statement);
      return readStorageDatabaseMigrationJournal(database, path);
    } finally {
      closeStorageDatabase(database);
    }
  };
}

describe("createStorageDatabase", () => {
  test("目标已存在时拒绝覆盖，原文件原样保留", async () => {
    const path: string = join(tempRoot(), "storage.sqlite");
    await Bun.write(path, "existing");

    expect(() => createStorageDatabase(path)).toThrow(`${path}: target already exists; refusing to overwrite it.`);
    expect(await Bun.file(path).text()).toBe("existing");
  });
});

describe("readStorageDatabaseMigrationJournal", () => {
  test("新库的谱系按时间升序、时间戳为正、哈希为 SHA-256", () => {
    const rows: readonly StorageDatabaseMigrationJournalEntry[] = journalAfter(null)();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number.isSafeInteger(row.createdAt) && row.createdAt > 0).toBeTrue();
      expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test.each([
    ["哈希不是 SHA-256", "UPDATE __drizzle_migrations SET hash = 'not-a-hash';"],
    ["时间戳不为正", "UPDATE __drizzle_migrations SET created_at = 0;"],
    ["时间戳不是整数", "UPDATE __drizzle_migrations SET created_at = 1.5;"],
  ])("%s时按未知历史拒绝", (_label: string, statement: string) => {
    expect(journalAfter(statement)).toThrow(":__drizzle_migrations: expected positive timestamps and SHA-256 hashes.");
  });
});
