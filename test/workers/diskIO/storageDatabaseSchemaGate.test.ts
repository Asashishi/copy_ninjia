import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_WHITELIST_PERMISSIONS } from
  "../../../packages/consts/whitelist";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import {
  encodeBlocklistEntryData,
  encodePendingBlockedRemovalData,
  encodeWhitelistEntryData,
} from "../../../packages/database/codec/identity";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { adoptStorageDatabase, hydrateStorageDatabase, inspectStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/hydration";
import { resetStorageDatabaseCache, storageDatabaseHandle } from
  "../../../packages/cache/workers/diskIO/storageDatabase";
import type { StorageDatabase } from "../../../packages/types/storageDatabase";
import type { PendingBlockedRemoval } from "../../../packages/types/blocklist";

/** 还原 v5 所需的原始 DDL、索引、migration 记录与 schema 版本行。 */
interface SchemaSnapshot {
  readonly chatQaDdl: string;
  readonly chatQaIndexDdl: string;
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
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_qa';"
    ).get();
  const indexDdl: { sql: string } | null = database.$client
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'chat_qa_q';"
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
  if (ddl === null || indexDdl === null || migration === null || version === null) {
    throw new Error("test fixture expects a fully migrated v5 database");
  }
  return {
    chatQaDdl: ddl.sql,
    chatQaIndexDdl: indexDdl.sql,
    migrationHash: migration.hash,
    migrationCreatedAt: migration.createdAt,
    versionText: version.text,
  };
}

let snapshot: SchemaSnapshot | null = null;

/** 把本文件的测试库改成上一版 release 的 v4 形态：无 chat_qa，版本回到 4。 */
function degradeToSchemaV4(): void {
  withDatabase((database: StorageDatabase): void => {
    // 先登记还原信息再破坏：赋值排在 DDL 之前，任何一步失败 afterEach 都能收拾。
    snapshot = readSchemaSnapshot(database);
    database.$client.run("DROP TABLE chat_qa;");
    database.$client.run(
      "DELETE FROM __drizzle_migrations WHERE created_at = ?;",
      [snapshot.migrationCreatedAt]
    );
    database.$client.run(
      "UPDATE storage_metadata SET data = jsonb(?) WHERE key = 'schema-version';",
      ['{"version":4}']
    );
  });
}

function restoreSchemaV5(restored: SchemaSnapshot): void {
  withDatabase((database: StorageDatabase): void => {
    // DDL 取自 sqlite_master，逐字写回本库自己的建表语句。
    database.$client.run(restored.chatQaDdl);
    database.$client.run(restored.chatQaIndexDdl);
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
  if (pending !== null) restoreSchemaV5(pending);
  withDatabase((database: StorageDatabase): void => {
    database.$client.run("DELETE FROM pending_blocked_removals;");
    database.$client.run("DELETE FROM whitelist_entries;");
    database.$client.run("DELETE FROM blocklist_entries;");
    database.$client.run("DELETE FROM chat_states;");
    database.$client.run("DELETE FROM chat_qa;");
  });
});

function identityMeta(): {
  readonly firstName: string;
  readonly lastName: string;
  readonly username: string;
} {
  return { firstName: "Test", lastName: "", username: "test" };
}

interface InsertJsonbRowOptions {
  readonly database: StorageDatabase;
  readonly table: "blocklist_entries" | "chat_states" | "pending_blocked_removals" | "whitelist_entries";
  readonly idColumn: "chat_id" | "id" | "removal_id";
  readonly id: number;
  readonly data: string;
}

function insertJsonbRow({
  database,
  table,
  idColumn,
  id,
  data,
}: InsertJsonbRowOptions): void {
  database.$client.run(
    `INSERT INTO ${table} (${idColumn}, data) VALUES (?1, jsonb(?2));`,
    [id, data]
  );
}

describe("共享存储库的启动 schema 闸", () => {
  test("未迁移的 v4 库报 schema 版本，而不是 chat_qa 缺表", () => {
    degradeToSchemaV4();

    // 版本判定必须先于任何按版本才存在的表：先读 startup rows 的话，这里拿到的
    // 是 `no such table: chat_qa`，运维照着那句排查不会想到该跑冷迁移。
    expect(() => hydrateStorageDatabase()).toThrow(
      `${IDENTITY_DATABASE_PATH}: storage_metadata schema-version must be {"version":5}.`
    );
  });

  test("当前 v5 库照常 hydrate", () => {
    expect(hydrateStorageDatabase()).toEqual({
      blocklistEntryCount: 0,
      whitelistEntryCount: 0,
      pendingBlockedRemovals: new Map(),
      chatStates: new Map(),
      chatQa: new Map(),
    });
  });

  test("inspect 使用只读短连接且不发布 owner，adopt 才建立可写连接", () => {
    resetStorageDatabaseCache();
    const inspection = inspectStorageDatabase();

    expect(storageDatabaseHandle.current).toBeNull();
    expect(inspection.hydration).toEqual({
      blocklistEntryCount: 0,
      whitelistEntryCount: 0,
      pendingBlockedRemovals: new Map(),
      chatStates: new Map(),
      chatQa: new Map(),
    });

    expect(adoptStorageDatabase(inspection)).toEqual(inspection.hydration);
    expect(storageDatabaseHandle.current).not.toBeNull();
    resetStorageDatabaseCache();
  });

  test("身份行字段损坏时在启动 inspect 阶段拒绝", () => {
    withDatabase((database: StorageDatabase): void => {
      insertJsonbRow({
        database,
        table: "whitelist_entries",
        idColumn: "id",
        id: 11,
        data: JSON.stringify({ permissions: {}, meta: identityMeta() }),
      });
    });

    expect(() => inspectStorageDatabase()).toThrow(
      /whitelist_entries\[11\]\.data.*permissions/
    );
    expect(storageDatabaseHandle.current).toBeNull();
  });

  test("黑白名单主键交叉时拒绝启动", () => {
    withDatabase((database: StorageDatabase): void => {
      insertJsonbRow({
        database,
        table: "whitelist_entries",
        idColumn: "id",
        id: 21,
        data: encodeWhitelistEntryData({
          permissions: DEFAULT_WHITELIST_PERMISSIONS,
          meta: identityMeta(),
        }),
      });
      insertJsonbRow({
        database,
        table: "blocklist_entries",
        idColumn: "id",
        id: 21,
        data: encodeBlocklistEntryData({
          blockedAt: "2026/08/27 12:00:00",
          meta: identityMeta(),
        }),
      });
    });

    expect(() => inspectStorageDatabase()).toThrow(/expected disjoint primary keys/);
  });

  test("群状态字段损坏时拒绝启动而不按宽松 JSON 恢复", () => {
    withDatabase((database: StorageDatabase): void => {
      insertJsonbRow({
        database,
        table: "chat_states",
        idColumn: "chat_id",
        id: -1_001,
        data: JSON.stringify({ isInitEnabled: "yes" }),
      });
    });

    expect(() => inspectStorageDatabase()).toThrow(/chat_states\[-1001\]\.data/);
  });

  test("待踢 outbox 引用不存在的黑名单身份时拒绝启动", () => {
    const pending: PendingBlockedRemoval = {
      params: {
        chatId: -1_001,
        probeMembership: false,
        userIds: [31],
        removalId: 1,
      },
      createdAt: 1_000,
      attempts: 0,
      lastFailure: null,
    };
    withDatabase((database: StorageDatabase): void => {
      insertJsonbRow({
        database,
        table: "pending_blocked_removals",
        idColumn: "removal_id",
        id: 1,
        data: encodePendingBlockedRemovalData(pending).text,
      });
    });

    expect(() => inspectStorageDatabase()).toThrow(
      /pending_blocked_removals\[1\]\.data.*must all exist/
    );
  });

  test("migration 谱系 hash 被改写时拒绝启动", () => {
    let originalHash: string = "";
    withDatabase((database: StorageDatabase): void => {
      const row: { readonly hash: string } | null = database.$client
        .query<{ readonly hash: string }, []>(
          "SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1;"
        )
        .get();
      originalHash = row?.hash ?? "";
      database.$client.run(
        "UPDATE __drizzle_migrations SET hash = ?1 WHERE created_at = " +
        "(SELECT MAX(created_at) FROM __drizzle_migrations);",
        ["0".repeat(64)]
      );
    });
    try {
      expect(() => inspectStorageDatabase()).toThrow(/exact supported schema v5 migration lineage/);
    } finally {
      withDatabase((database: StorageDatabase): void => {
        database.$client.run(
          "UPDATE __drizzle_migrations SET hash = ?1 WHERE created_at = " +
          "(SELECT MAX(created_at) FROM __drizzle_migrations);",
          [originalHash]
        );
      });
    }
  });
});
