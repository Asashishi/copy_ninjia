import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_WHITELIST_PERMISSIONS } from
  "../../../packages/consts/whitelist";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import {
  IDENTITY_DATABASE_METADATA_KEYS,
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_DATABASE_SCHEMA_VERSION,
  IDENTITY_DATABASE_TIME_ZONE_KEY,
} from "../../../packages/consts/identityStorage";
import { getTimeZone } from "../../../packages/config/time";
import { storageMetadataRows } from "../../../packages/database/interact/initialization";
import {
  encodeBlocklistEntryData,
  encodePendingBlockedRemovalData,
  encodeWhitelistEntryData,
} from "../../../packages/database/codec/identity";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { adoptStorageDatabase, inspectStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/hydration";
import { hydrateStorageDatabase } from "../../helpers/storageDatabaseHydration";
import { resetStorageDatabaseCache, storageDatabaseHandle } from
  "../../../packages/cache/workers/diskIO/storageDatabase";
import type { StorageDatabase } from "../../../packages/types/storageDatabase";
import type { PendingBlockedRemoval } from "../../../packages/types/blocklist";

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

afterEach((): void => {
  withDatabase((database: StorageDatabase): void => {
    database.$client.run("DELETE FROM pending_blocked_removals;");
    database.$client.run("DELETE FROM permission_list;");
    database.$client.run("DELETE FROM blocklist_entries;");
    database.$client.run("DELETE FROM chat_states;");
    database.$client.run("DELETE FROM chat_qa;");
    database.$client.run("DELETE FROM temporary_ad_bypass_entries;");
    database.$client.run("DELETE FROM storage_metadata;");
    for (const row of storageMetadataRows(getTimeZone())) {
      database.$client.run("INSERT INTO storage_metadata (key, data) VALUES (?1, jsonb(?2));", [row.key, row.data]);
    }
  });
});

/** 夹具自选的、与本进程配置时区不同的合法时区。 */
function otherTimeZone(): string {
  return getTimeZone() === "UTC" ? "Asia/Seoul" : "UTC";
}

function setTimeZoneMarker(database: StorageDatabase, data: string): void {
  database.$client.run(
    "UPDATE storage_metadata SET data = jsonb(?1) WHERE key = ?2;",
    [data, IDENTITY_DATABASE_TIME_ZONE_KEY]
  );
}

function identityMeta(): {
  readonly firstName: string;
  readonly lastName: string;
  readonly username: string;
} {
  return { firstName: "Test", lastName: "", username: "test" };
}

interface InsertJsonbRowOptions {
  readonly database: StorageDatabase;
  readonly table: "blocklist_entries" | "chat_states" | "pending_blocked_removals" | "permission_list";
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
    `INSERT INTO ${table} (${idColumn}, ${table === "chat_states" ? "status" : table === "permission_list" ? "policy" : "data"}) VALUES (?1, jsonb(?2));`,
    [id, data]
  );
}

describe("共享存储库的启动 schema 闸", () => {
  test("当前 schema 库照常 hydrate", () => {
    expect(hydrateStorageDatabase()).toEqual({
      blocklistEntryCount: 0,
      permissionEntryCount: 0,
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
      permissionEntryCount: 0,
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
        table: "permission_list",
        idColumn: "id",
        id: 11,
        data: JSON.stringify({ permissions: {}, meta: identityMeta() }),
      });
    });

    expect(() => inspectStorageDatabase()).toThrow(
      /permission_list\[11\]\.policy.*permissions/
    );
    expect(storageDatabaseHandle.current).toBeNull();
  });

  test("黑白名单主键交叉时拒绝启动", () => {
    withDatabase((database: StorageDatabase): void => {
      insertJsonbRow({
        database,
        table: "permission_list",
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

  test("临时广告免检与黑名单主键交叉时拒绝启动", () => {
    withDatabase((database: StorageDatabase): void => {
      insertJsonbRow({
        database,
        table: "blocklist_entries",
        idColumn: "id",
        id: 22,
        data: encodeBlocklistEntryData({
          blockedAt: "2026/08/27 12:00:00",
          meta: identityMeta(),
        }),
      });
      database.$client.run(
        "INSERT INTO temporary_ad_bypass_entries " +
        "(id, ad_bypass, ad_bypass_granted_at, qualified_days, send_count, " +
        "counted_at, qualified_at) VALUES (?1, 0, NULL, 0, 1, ?2, NULL);",
        [22, Date.now()]
      );
    });

    expect(() => inspectStorageDatabase()).toThrow(
      /temporary_ad_bypass_entries\/blocklist_entries.*expected disjoint primary keys/
    );
  });

  test("墙钟回拨留下的未来活动时间不被误判为数据库字段损坏", () => {
    const future: number = Date.now() + 60_000;
    withDatabase((database: StorageDatabase): void => {
      database.$client.run(
        "INSERT INTO temporary_ad_bypass_entries " +
        "(id, ad_bypass, ad_bypass_granted_at, qualified_days, send_count, " +
        "counted_at, qualified_at) VALUES (?1, 0, NULL, 0, 1, ?2, NULL);",
        [24, future]
      );
    });

    expect(() => inspectStorageDatabase()).not.toThrow();
  });

  test("临时广告免检跨东京日的合格时间损坏时拒绝启动", () => {
    withDatabase((database: StorageDatabase): void => {
      database.$client.run(
        "INSERT INTO temporary_ad_bypass_entries " +
        "(id, ad_bypass, ad_bypass_granted_at, qualified_days, send_count, " +
        "counted_at, qualified_at) VALUES (?1, 1, ?3, 1, 8, ?2, ?3);",
        [23, 90_000_000, 1_000]
      );
    });

    expect(() => inspectStorageDatabase()).toThrow(
      /temporary_ad_bypass_entries\[23\].*qualified_at/
    );
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

    expect(() => inspectStorageDatabase()).toThrow(/chat_states\[-1001\]\.status/);
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

  test("数据根时区标记不等于配置时区时拒绝启动，点名字段与期望值", () => {
    withDatabase((database: StorageDatabase): void => {
      setTimeZoneMarker(database, JSON.stringify({ timeZone: otherTimeZone() }));
    });

    expect(() => inspectStorageDatabase()).toThrow(
      `${IDENTITY_DATABASE_PATH}: storage_metadata.${IDENTITY_DATABASE_TIME_ZONE_KEY} must be ${JSON.stringify({ timeZone: getTimeZone() })}.`
    );
    expect(storageDatabaseHandle.current).toBeNull();
  });

  test("时区标记大小写非规范时按非法值拒绝", () => {
    withDatabase((database: StorageDatabase): void => {
      setTimeZoneMarker(database, JSON.stringify({ timeZone: getTimeZone().toUpperCase() }));
    });

    expect(() => inspectStorageDatabase()).toThrow(
      `${IDENTITY_DATABASE_PATH}:storage_metadata[${IDENTITY_DATABASE_TIME_ZONE_KEY}].data: $.timeZone must be`
    );
  });

  test("缺时区标记或多出 metadata 键时拒绝启动", () => {
    withDatabase((database: StorageDatabase): void => {
      database.$client.run("DELETE FROM storage_metadata WHERE key = ?1;", [IDENTITY_DATABASE_TIME_ZONE_KEY]);
    });
    expect(() => inspectStorageDatabase()).toThrow(`storage_metadata must contain exactly one ${IDENTITY_DATABASE_TIME_ZONE_KEY} row.`);

    withDatabase((database: StorageDatabase): void => {
      database.$client.run(
        "INSERT INTO storage_metadata (key, data) VALUES (?1, jsonb(?2)), ('extra', jsonb('{}'));",
        [IDENTITY_DATABASE_TIME_ZONE_KEY, JSON.stringify({ timeZone: getTimeZone() })]
      );
    });
    expect(() => inspectStorageDatabase()).toThrow(
      `storage_metadata must contain only the ${IDENTITY_DATABASE_METADATA_KEYS.join(" and ")} rows.`
    );
  });

  test("旧版本库缺时区标记时先报版本诊断", () => {
    withDatabase((database: StorageDatabase): void => {
      database.$client.run("DELETE FROM storage_metadata WHERE key = ?1;", [IDENTITY_DATABASE_TIME_ZONE_KEY]);
      database.$client.run(
        "UPDATE storage_metadata SET data = jsonb(?1) WHERE key = ?2;",
        [JSON.stringify({ version: IDENTITY_DATABASE_SCHEMA_VERSION - 1 }), IDENTITY_DATABASE_SCHEMA_KEY]
      );
    });

    expect(() => inspectStorageDatabase()).toThrow(
      `storage_metadata schema-version must be ${JSON.stringify({ version: IDENTITY_DATABASE_SCHEMA_VERSION })}.`
    );
  });

  test("时区标记先于免检行的同日约束：换时区只报标记", () => {
    withDatabase((database: StorageDatabase): void => {
      database.$client.run(
        "INSERT INTO temporary_ad_bypass_entries " +
        "(id, ad_bypass, ad_bypass_granted_at, qualified_days, send_count, " +
        "counted_at, qualified_at) VALUES (?1, 1, ?3, 1, 8, ?2, ?3);",
        [23, 90_000_000, 1_000]
      );
      setTimeZoneMarker(database, JSON.stringify({ timeZone: otherTimeZone() }));
    });

    expect(() => inspectStorageDatabase()).toThrow(`storage_metadata.${IDENTITY_DATABASE_TIME_ZONE_KEY} must be`);
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
      expect(() => inspectStorageDatabase()).toThrow(`exact supported schema v${IDENTITY_DATABASE_SCHEMA_VERSION} migration lineage`);
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
