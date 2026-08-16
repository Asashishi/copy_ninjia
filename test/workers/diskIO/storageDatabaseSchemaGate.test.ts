import { afterEach, describe, expect, test } from "bun:test";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { hydrateStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/hydration";
import { resetStorageDatabaseCache } from
  "../../../packages/cache/workers/diskIO/storageDatabase";
import type { StorageDatabase } from "../../../packages/types/storageDatabase";

/** 还原 v4 所需的原始 DDL、migration 记录与 schema 版本行。 */
interface SchemaSnapshot {
  readonly chatStatesDdl: string;
  readonly migrationHash: string;
  readonly migrationCreatedAt: number;
  readonly versionText: string;
}

function withDatabase<T>(run: (database: StorageDatabase) => T): T {
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
    requireWritableAccess: true,
  });
  try {
    return run(database);
  } finally {
    closeStorageDatabase(database);
    resetStorageDatabaseCache();
  }
}

/** 还原信息必须在任何破坏性 DDL 之前读齐，否则中途失败就无法复原本文件的库。 */
function readSchemaSnapshot(database: StorageDatabase): SchemaSnapshot {
  const ddl: { sql: string } | null = database.$client
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_states';"
    ).get();
  const migration: { hash: string; createdAt: number } | null = database.$client
    .query<{ hash: string; createdAt: number }, []>(
      "SELECT hash, created_at AS createdAt FROM __drizzle_migrations " +
      "ORDER BY created_at DESC LIMIT 1;"
    ).get();
  const version: { text: string } | null = database.$client
    .query<{ text: string }, []>(
      "SELECT json(data) AS text FROM storage_metadata WHERE key = 'schema-version';"
    ).get();
  if (ddl === null || migration === null || version === null) {
    throw new Error("test fixture expects a fully migrated v4 database");
  }
  return {
    chatStatesDdl: ddl.sql,
    migrationHash: migration.hash,
    migrationCreatedAt: migration.createdAt,
    versionText: version.text,
  };
}

let snapshot: SchemaSnapshot | null = null;

/** 把本文件的测试库改成上一版 release 的 v3 形态：无 chat_states，版本回到 3。 */
function degradeToSchemaV3(): void {
  withDatabase((database: StorageDatabase): void => {
    // 先登记还原信息再破坏：赋值排在 DDL 之前，任何一步失败 afterEach 都能收拾。
    snapshot = readSchemaSnapshot(database);
    database.$client.run("DROP TABLE chat_states;");
    database.$client.run(
      "DELETE FROM __drizzle_migrations WHERE created_at = ?;",
      [snapshot.migrationCreatedAt]
    );
    database.$client.run(
      "UPDATE storage_metadata SET data = jsonb(?) WHERE key = 'schema-version';",
      ['{"version":3}']
    );
  });
}

function restoreSchemaV4(restored: SchemaSnapshot): void {
  withDatabase((database: StorageDatabase): void => {
    // DDL 取自 sqlite_master，逐字写回本库自己的建表语句。
    database.$client.run(restored.chatStatesDdl);
    database.$client.run(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?);",
      [restored.migrationHash, restored.migrationCreatedAt]
    );
    database.$client.run(
      "UPDATE storage_metadata SET data = jsonb(?) WHERE key = 'schema-version';",
      [restored.versionText]
    );
  });
}

afterEach(() => {
  const pending: SchemaSnapshot | null = snapshot;
  snapshot = null;
  if (pending !== null) restoreSchemaV4(pending);
});

describe("共享存储库的启动 schema 闸", () => {
  test("未迁移的 v3 库报 schema 版本，而不是 chat_states 缺表", () => {
    degradeToSchemaV3();

    // 版本判定必须先于任何按版本才存在的表：先读 startup rows 的话，这里拿到的
    // 是 `no such table: chat_states`，运维照着那句排查不会想到该跑冷迁移。
    expect(() => hydrateStorageDatabase()).toThrow(
      `${IDENTITY_DATABASE_PATH}: storage_metadata schema-version must be {"version":4}.`
    );
  });

  test("当前 v4 库照常 hydrate", () => {
    expect(hydrateStorageDatabase()).toEqual({
      blocklistEntryCount: 0,
      whitelistEntryCount: 0,
      pendingBlockedRemovals: new Map(),
      chatStates: new Map(),
    });
  });
});
