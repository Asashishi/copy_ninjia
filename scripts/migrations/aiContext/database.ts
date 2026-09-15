import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import {
  IDENTITY_DATABASE_MIGRATIONS_DIR, IDENTITY_DATABASE_SCHEMA_VERSION,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT, IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT, IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  AI_CONTEXT_MIGRATION_CREATED_AT, AI_CONTEXT_MIGRATION_HASH,
} from "../../../packages/consts/identityStorage";
import { chatStates } from "../../../packages/database/schema/chatState";
import { decodeWhitelistEntryData } from "../../../packages/database/codec/identity";
import { readStorageDatabaseMigrationJournal } from "../../../packages/database/interact/migration";
import {
  assertStorageDatabaseIntegrity, assertStorageDatabaseJsonbStorage,
  assertStorageDatabaseMigrationLineage, assertStoredIdentityPolicies,
  readStorageDatabaseSchemaMetadata, readStorageDatabaseStartupRows,
} from "../../../packages/database/interact/inspection";
import {
  assertPendingRemovalBlocklistReferences, decodeStoredChatStates, decodeStoredChatQa,
  decodeStoredPendingRemovals, readStorageSchemaVersion,
} from "../../../packages/database/validation/storageRows";
import { readStoredAiContexts } from "../../../packages/database/interact/aiContext";
import { invalidInput, parseJsonInput } from "../../../packages/libs/inputValidation";
import { isPlainRecord } from "../../../packages/libs/record";
import type { StorageDatabase, StorageDatabaseMigrationJournalEntry, StoredIdentityPolicyRow, StoredPendingRemovalRow } from "../../../packages/types/storageDatabase";
import type { MigrationMeta } from "drizzle-orm/migrator";

/** 上次迁移的 JSONB 列集合，仅用于冷副本的迁移前校验。 */
const SOURCE_JSONB_TABLES: readonly string[] = ["whitelist_entries", "blocklist_entries", "pending_blocked_removals", "storage_metadata", "chat_states", "chat_qa"];

/** 本次冷迁移只接受上次迁移产出的 schema v8。 */
const SOURCE_SCHEMA_VERSION: number = 8;

/** 校验 v8 的完整已发布谱系；未知、过旧和额外条目一律拒绝。 */
function assertSourceLineage(database: StorageDatabase, source: string): void {
  const migrations: MigrationMeta[] = readMigrationFiles({ migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
  const last: MigrationMeta | undefined = migrations.at(-1);
  if (last?.folderMillis !== AI_CONTEXT_MIGRATION_CREATED_AT || last.hash !== AI_CONTEXT_MIGRATION_HASH) {
    return invalidInput(source, "__drizzle_migrations", "the current AI context migration files");
  }
  const expected: readonly StorageDatabaseMigrationJournalEntry[] = migrations.slice(0, -1).map(
    (entry: MigrationMeta): StorageDatabaseMigrationJournalEntry => ({ createdAt: entry.folderMillis, hash: entry.hash })
  );
  const historical: readonly StorageDatabaseMigrationJournalEntry[] = [
    { createdAt: IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT, hash: IDENTITY_DATABASE_TEXT_MIGRATION_HASH },
    { createdAt: IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT, hash: IDENTITY_DATABASE_JSONB_MIGRATION_HASH },
    ...expected.slice(1),
  ];
  const actual: string = JSON.stringify(readStorageDatabaseMigrationJournal(database, source));
  if (actual !== JSON.stringify(expected) && actual !== JSON.stringify(historical)) {
    return invalidInput(source, "__drizzle_migrations", "the exact schema v8 lineage");
  }
}

/** 只补本次新增权限，其他权限必须满足上次迁移的完整布尔形态。 */
function assertSourcePermissions(database: StorageDatabase, source: string): void {
  for (const row of database.$client.query<StoredIdentityPolicyRow, []>(
    "SELECT id, json(data) AS data FROM whitelist_entries ORDER BY id;"
  ).iterate()) {
    const path: string = `${source}:whitelist_entries[${row.id}].data`;
    const value: unknown = parseJsonInput(row.data, path);
    if (!isPlainRecord(value) || !isPlainRecord(value.permissions) || "isCanConfigAiPrompt" in value.permissions) {
      return invalidInput(path, "$.permissions", "the complete schema v8 permissions object");
    }
    const allEnabled: boolean = Object.values(value.permissions).every((field: unknown): boolean => field === true);
    decodeWhitelistEntryData(JSON.stringify({ ...value, permissions: { ...value.permissions, isCanConfigAiPrompt: allEnabled } }), path);
  }
}

/** 当前格式的完整只读门禁；冷迁移产物和中断重跑都必须通过。 */
function validateCurrentDatabase(database: StorageDatabase, source: string): void {
  assertStorageDatabaseMigrationLineage(database, source);
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  assertStoredIdentityPolicies(database, source);
  const rows: ReturnType<typeof readStorageDatabaseStartupRows> = readStorageDatabaseStartupRows(database);
  decodeStoredChatStates(rows.chatStates, source);
  decodeStoredChatQa(rows.chatQa, source);
  readStoredAiContexts(database, source);
  for (const row of database.$client.query<StoredPendingRemovalRow, []>(
    "SELECT removal_id AS removalId, json(data) AS data FROM pending_blocked_removals ORDER BY removal_id;"
  ).iterate()) {
    assertPendingRemovalBlocklistReferences(database, decodeStoredPendingRemovals([row], source).values, source);
  }
}

export interface AiContextMigrationCounts {
  readonly importedContexts: number;
  readonly discardedContexts: number;
}

/** 独立副本中执行 v8 → v9；只导入已有群状态的记忆，禁止用记忆新建群状态。 */
export function migrateAiContextDatabase(database: StorageDatabase, source: string, snapshots: ReadonlyMap<number, string>): AiContextMigrationCounts {
  const version: number = readStorageSchemaVersion({ metadata: readStorageDatabaseSchemaMetadata(database) }, source);
  if (version !== SOURCE_SCHEMA_VERSION) return invalidInput(source, "storage_metadata", "schema version 8 from the preceding migration");
  assertSourceLineage(database, source);
  assertStorageDatabaseIntegrity(database, source);
  for (const table of SOURCE_JSONB_TABLES) {
    const declaration: { type: string } | null = database.$client.query<{ type: string }, [string]>("SELECT type FROM pragma_table_xinfo(?) WHERE name = 'data'").get(table);
    const invalid: { count: number } | null = database.$client.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table} WHERE typeof(data) <> 'blob' OR json_valid(data, 8) <> 1`).get();
    if (declaration?.type.toUpperCase() !== "BLOB" || invalid?.count !== 0) return invalidInput(source, `${table}.data`, "a BLOB column containing only strict SQLite JSONB");
  }
  assertSourcePermissions(database, source);
  migrate(database, { migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
  let importedContexts: number = 0;
  let discardedContexts: number = 0;
  database.transaction((transaction: Parameters<Parameters<StorageDatabase["transaction"]>[0]>[0]): void => {
    for (const [chatId, snapshot] of snapshots) {
      const changed: readonly Readonly<{ chatId: number }>[] = transaction.update(chatStates).set({ aiContext: snapshot })
        .where(eq(chatStates.chatId, chatId)).returning({ chatId: chatStates.chatId }).all();
      if (changed.length === 1) importedContexts++;
      else discardedContexts++;
    }
  });
  if (readStorageSchemaVersion({ metadata: readStorageDatabaseSchemaMetadata(database) }, source) !== IDENTITY_DATABASE_SCHEMA_VERSION) {
    return invalidInput(source, "storage_metadata", "the current schema version");
  }
  validateCurrentDatabase(database, source);
  const checkpoint: Readonly<{ busy: number; log: number; checkpointed: number }> | null = database.$client
    .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE);").get();
  if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) return invalidInput(source, "wal_checkpoint", "a complete checkpoint without busy readers or writers");
  return { importedContexts, discardedContexts };
}
