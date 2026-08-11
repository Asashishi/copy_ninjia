import { afterEach, describe, expect, test } from "bun:test";
import { GrammyError } from "grammy";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WHITELIST_PERMISSIONS,
  WHITELIST_PERMISSION_KEYS,
} from "../../packages/consts/whitelist";
import {
  IDENTITY_DATABASE_CURRENT_BASE_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH,
  IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
} from
  "../../packages/consts/identityStorage";
import {
  assertIdentityDatabaseIntegrity,
  assertIdentityDatabaseJsonbStorage,
  closeIdentityDatabase,
  createIdentityDatabase,
  migrateIdentityDatabaseSchema,
  openIdentityDatabase,
  putIdentityPolicyRow,
  readIdentityDatabaseMigrationJournal,
  readStoredIdentityPolicies,
  readIdentityDatabaseRows,
  readIdentityDatabaseJsonStorage,
  serializeIdentityDatabaseSnapshot,
} from "../../packages/database/interact/identity";
import type {
  IdentityDatabase,
  IdentityDatabaseMigrationJournalEntry,
  IdentityDatabaseRows,
  IdentityDatabaseJsonStorageRow,
} from "../../packages/types/identityDatabase";
import {
  decodeWhitelistEntryData,
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../packages/database/codec/identity";
import {
  insertMigratedRows,
  isBotKickedFromChatError,
  loadMigrationInput,
  verifyDatabase,
} from "../../scripts/migrateIdentityStorageToSqlite";
import type { PendingBlockedRemoval } from "../../packages/types/blocklist";
import type {
  TelegramIdentityMetadata,
  WhitelistPermissions,
} from "../../packages/types/identityPolicy";
import type {
  InsertMigratedRowsParams,
  VerifyDatabaseParams,
} from "../../scripts/migrateIdentityStorageToSqlite";
import type { MigrationInput } from "../../packages/types/identityStorageMigration";

const BLOCKED_AT: string = "2026/08/11 12:34:56";
const WHITE_META: Readonly<TelegramIdentityMetadata> = {
  firstName: "天才",
  lastName: "猫",
  username: "genius",
};
const BLACK_META: Readonly<TelegramIdentityMetadata> = {
  firstName: "频道",
  lastName: "",
  username: "channel",
};
const REMOVAL: PendingBlockedRemoval = {
  params: {
    chatId: -1_001,
    probeMembership: false,
    userIds: [-8],
    removalId: 9,
  },
  createdAt: 1_000,
  attempts: 0,
  lastFailure: null,
};

let temporaryRoot: string | null = null;

function freshMigrationJournal(): readonly IdentityDatabaseMigrationJournalEntry[] {
  return [
    {
      createdAt: IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
      hash: IDENTITY_DATABASE_CURRENT_BASE_MIGRATION_HASH,
    },
    {
      createdAt: IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT,
      hash: IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH,
    },
  ];
}

function upgradedMigrationJournal(): readonly IdentityDatabaseMigrationJournalEntry[] {
  return [
    {
      createdAt: IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
      hash: IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
    },
    {
      createdAt: IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
      hash: IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
    },
    {
      createdAt: IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT,
      hash: IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH,
    },
  ];
}

afterEach((): void => {
  if (temporaryRoot === null) return;
  rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

function fixture(): {
  readonly path: string;
  readonly input: MigrationInput;
  readonly metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>>;
} {
  temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-migration-test-"));
  const path: string = join(temporaryRoot, "storage.sqlite");
  const input: MigrationInput = {
    whitelist: new Map([[7, DEFAULT_WHITELIST_PERMISSIONS]]),
    blockedIds: [-8],
    removals: new Map([[9, REMOVAL]]),
  };
  const metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>> = new Map([
    [7, WHITE_META],
    [-8, BLACK_META],
  ]);
  return { path, input, metadata };
}

function createMigratedDatabase({
  path,
  input,
  metadata,
}: ReturnType<typeof fixture>): void {
  createIdentityDatabase(path);
  const database: InsertMigratedRowsParams["database"] = openIdentityDatabase({ path });
  try {
    insertMigratedRows({ database, input, metadata, blockedAt: BLOCKED_AT });
  } finally {
    closeIdentityDatabase(database);
  }
}

describe("旧 JSON 身份存储直达 SQLite JSONB", () => {
  test("配置白名单、静态/动态黑名单和待踢 memory 合并后直接写成 JSONB", () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-legacy-jsonb-test-"));
    const whitelistPath: string = join(temporaryRoot, "whitelist.json");
    const staticBlocklistPath: string = join(temporaryRoot, "blocklist.json");
    const dynamicBlocklistPath: string = join(temporaryRoot, "memory", "blocklist.json");
    const removalOutboxPath: string = join(temporaryRoot, "memory", "removals.json");
    mkdirSync(join(temporaryRoot, "memory"));
    const oldAllPermissions: Record<string, boolean> = {};
    for (const key of WHITELIST_PERMISSION_KEYS) {
      if (key !== "isCanWhiteOther") oldAllPermissions[key] = true;
    }
    writeFileSync(whitelistPath, JSON.stringify({
      "7": { isCanBlock: true },
      "8": oldAllPermissions,
    }));
    writeFileSync(staticBlocklistPath, JSON.stringify({ blockedIds: [-8] }));
    writeFileSync(dynamicBlocklistPath, JSON.stringify({
      "-9": { isBlocked: true, blockedAt: BLOCKED_AT },
    }));
    const removal: PendingBlockedRemoval = {
      ...REMOVAL,
      params: {
        chatId: -1_001,
        probeMembership: false,
        userIds: [-8, -9],
        removalId: 9,
      },
    };
    writeFileSync(removalOutboxPath, JSON.stringify({ version: 2, entries: [removal] }));

    const input: MigrationInput = loadMigrationInput({
      whitelistPath,
      staticBlocklistPath,
      dynamicBlocklistPath,
      removalOutboxPath,
      superAdminUserId: 1,
    });
    const path: string = join(temporaryRoot, "storage.sqlite");
    const metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>> = new Map([
      [7, WHITE_META],
      [8, { firstName: "All", lastName: "", username: "all" }],
      [-8, BLACK_META],
      [-9, { ...BLACK_META, username: "dynamic" }],
    ]);
    createMigratedDatabase({ path, input, metadata });
    const database: IdentityDatabase = openIdentityDatabase({ path });
    try {
      assertIdentityDatabaseJsonbStorage(database, path);
      const rows: IdentityDatabaseRows = readIdentityDatabaseRows(database);
      expect(rows.whitelist).toHaveLength(2);
      expect(rows.blocklist).toHaveLength(2);
      expect(rows.removals).toHaveLength(1);
      expect(readIdentityDatabaseMigrationJournal(database))
        .toEqual(freshMigrationJournal());
      expect(input.whitelist.get(7)?.isCanWhiteOther).toBeFalse();
      expect(input.whitelist.get(8)?.isCanWhiteOther).toBeTrue();
    } finally {
      closeIdentityDatabase(database);
    }
  });

  test("migration 链建立四张严格 JSONB 表，读取边界返回规范 JSON 文本", () => {
    const value: ReturnType<typeof fixture> = fixture();
    createMigratedDatabase(value);
    const database: IdentityDatabase = openIdentityDatabase({ path: value.path });
    try {
      expect(() => assertIdentityDatabaseJsonbStorage(database, value.path)).not.toThrow();
      const storage: readonly IdentityDatabaseJsonStorageRow[] =
        readIdentityDatabaseJsonStorage(database);
      expect(storage).toHaveLength(4);
      for (const row of storage) {
        expect(row.declaredType).toBe("BLOB");
        expect(row.textRows).toBe(0);
        expect(row.blobRows).toBe(row.rowCount);
        expect(row.invalidJsonbRows).toBe(0);
      }
      expect(readIdentityDatabaseMigrationJournal(database))
        .toEqual(freshMigrationJournal());
      const snapshotPath: string = `${value.path}.snapshot`;
      writeFileSync(snapshotPath, serializeIdentityDatabaseSnapshot(database));
      const snapshot: IdentityDatabase = openIdentityDatabase({
        path: snapshotPath,
        readonly: true,
      });
      try {
        expect(() => assertIdentityDatabaseIntegrity(snapshot)).not.toThrow();
        expect(() => assertIdentityDatabaseJsonbStorage(snapshot, snapshotPath))
          .not.toThrow();
      } finally {
        closeIdentityDatabase(snapshot);
      }

      const rows: IdentityDatabaseRows = readIdentityDatabaseRows(database);
      const texts: string[] = [
        ...rows.metadata.map((row): string => row.data),
        ...rows.whitelist.map((row): string => row.data),
        ...rows.blocklist.map((row): string => row.data),
        ...rows.removals.map((row): string => row.data),
      ];
      expect(texts).toHaveLength(4);
      for (const text of texts) {
        expect(text).toBe(JSON.stringify(JSON.parse(text)));
      }
    } finally {
      closeIdentityDatabase(database);
    }
  });

  test("v2 白名单迁移：旧权限全 true 才补 isCanWhiteOther=true，其余默认 false", () => {
    const value: ReturnType<typeof fixture> = fixture();
    createMigratedDatabase(value);
    const database: IdentityDatabase = openIdentityDatabase({ path: value.path });
    try {
      const allPermissions: WhitelistPermissions = {
        ...DEFAULT_WHITELIST_PERMISSIONS,
      };
      for (const key of WHITELIST_PERMISSION_KEYS) allPermissions[key] = true;
      putIdentityPolicyRow({
        database,
        table: "whitelist",
        id: 8,
        data: encodeWhitelistEntryData({
          permissions: allPermissions,
          meta: { firstName: "All", lastName: "", username: "all" },
        }),
      });
      // 构造真实已部署 v2 现场：没有新字段、metadata=2，并保留文本建库后
      // 再转 JSONB 的两项历史 migration。
      database.$client.run(
        "UPDATE whitelist_entries " +
        "SET data = jsonb_remove(data, '$.permissions.isCanWhiteOther');"
      );
      database.$client.run(
        "UPDATE storage_metadata SET data = jsonb('{\"version\":2}') " +
        "WHERE key = 'schema-version';"
      );
      database.$client.run("DELETE FROM __drizzle_migrations;");
      const insertMigration = database.$client.prepare(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?1, ?2);"
      );
      insertMigration.run(
        IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
        IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT
      );
      insertMigration.run(
        IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
        IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT
      );
      const before: IdentityDatabaseRows = readIdentityDatabaseRows(database);
      expect(() => decodeWhitelistEntryData(before.whitelist[0]!.data, "v2 row"))
        .toThrow("complete supported boolean permission object");

      migrateIdentityDatabaseSchema(database);

      const after: IdentityDatabaseRows = readIdentityDatabaseRows(database);
      const permissionsById: Map<number, Readonly<WhitelistPermissions>> =
        new Map<number, Readonly<WhitelistPermissions>>();
      for (const row of after.whitelist) {
        permissionsById.set(
          row.id,
          decodeWhitelistEntryData(row.data, `whitelist_entries[${row.id}]`).permissions
        );
      }
      expect(permissionsById.get(7)?.isCanWhiteOther).toBeFalse();
      expect(permissionsById.get(8)?.isCanWhiteOther).toBeTrue();
      expect(after.metadata[0]?.data).toBe(IDENTITY_DATABASE_SCHEMA_DATA);
      expect(readIdentityDatabaseMigrationJournal(database))
        .toEqual(upgradedMigrationJournal());
      expect(() => assertIdentityDatabaseJsonbStorage(database, value.path))
        .not.toThrow();
    } finally {
      closeIdentityDatabase(database);
    }
  });

  test("批量冷读支持 4096 项硬顶，并拒绝越过主线程预取边界", () => {
    const value: ReturnType<typeof fixture> = fixture();
    createMigratedDatabase(value);
    const database: IdentityDatabase = openIdentityDatabase({ path: value.path });
    try {
      const ids: number[] = new Array<number>(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
      for (let index: number = 0; index < ids.length; index += 1) ids[index] = index + 1;
      expect(readStoredIdentityPolicies(database, "whitelist", ids)).toHaveLength(1);
      ids.push(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 1);
      expect(() => readStoredIdentityPolicies(database, "whitelist", ids))
        .toThrow(`at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs`);
    } finally {
      closeIdentityDatabase(database);
    }
  });

  test("只有 getChat 明确报告被群踢出时才允许删除旧白名单身份", () => {
    const kicked: GrammyError = new GrammyError(
      "getChat failed",
      {
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was kicked from the supergroup chat",
      },
      "getChat",
      {}
    );
    const unrelatedForbidden: GrammyError = new GrammyError(
      "getChat failed",
      {
        ok: false,
        error_code: 403,
        description: "Forbidden: bot is not a member of the channel chat",
      },
      "getChat",
      {}
    );
    const wrongMethod: GrammyError = new GrammyError(
      "getChatMember failed",
      {
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was kicked from the supergroup chat",
      },
      "getChatMember",
      {}
    );

    expect(isBotKickedFromChatError(kicked)).toBeTrue();
    expect(isBotKickedFromChatError(unrelatedForbidden)).toBeFalse();
    expect(isBotKickedFromChatError(wrongMethod)).toBeFalse();
    expect(isBotKickedFromChatError(new Error("network failed"))).toBeFalse();
  });

  test("白名单、黑名单 meta 与待踢行按主键逐值核对", () => {
    const value: ReturnType<typeof fixture> = fixture();
    createMigratedDatabase(value);
    const verify: VerifyDatabaseParams = {
      ...value,
      blockedAt: BLOCKED_AT,
    };
    expect(() => verifyDatabase(verify)).not.toThrow();

    const database: IdentityDatabase = openIdentityDatabase({ path: value.path });
    try {
      putIdentityPolicyRow({
        database,
        table: "blocklist",
        id: -8,
        data: encodeBlocklistEntryData({
          blockedAt: BLOCKED_AT,
          meta: { ...BLACK_META, username: "tampered" },
        }),
      });
    } finally {
      closeIdentityDatabase(database);
    }
    expect(() => verifyDatabase(verify)).toThrow("does not match its migrated source value");
  });

  test("Telegram 返回已清空资料的用户对象时保留身份并写入空 meta", () => {
    const value: ReturnType<typeof fixture> = fixture();
    const metadata: ReadonlyMap<number, Readonly<TelegramIdentityMetadata>> = new Map([
      [7, { firstName: "", lastName: "", username: "" }],
      [-8, BLACK_META],
    ]);
    const emptyMetaValue: ReturnType<typeof fixture> = { ...value, metadata };
    createMigratedDatabase(emptyMetaValue);

    expect(() => verifyDatabase({
      ...emptyMetaValue,
      blockedAt: BLOCKED_AT,
    })).not.toThrow();
  });
});
