import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  IDENTITY_DATABASE_MIGRATIONS_DIR,
  IDENTITY_DATABASE_SCHEMA_VERSION,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  IDENTITY_DATABASE_TRANSLATE_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TRANSLATE_MIGRATION_HASH,
} from "../../../packages/consts/identityStorage";
import { decodeWhitelistEntryData } from "../../../packages/database/codec/identity";
import { readStorageDatabaseMigrationJournal } from "../../../packages/database/interact/migration";
import {
  assertStorageDatabaseIntegrity,
  assertStorageDatabaseJsonbStorage,
  assertStorageDatabaseMigrationLineage,
  assertStoredIdentityPolicies,
  readStorageDatabaseSchemaMetadata,
  readStorageDatabaseStartupRows,
} from "../../../packages/database/interact/inspection";
import {
  assertPendingRemovalBlocklistReferences,
  decodeStoredChatStates,
  decodeStoredChatQa,
  decodeStoredPendingRemovals,
  readStorageSchemaVersion,
} from "../../../packages/database/validation/storageRows";
import { invalidInput, parseJsonInput } from "../../../packages/libs/inputValidation";
import { isPlainRecord } from "../../../packages/libs/record";
import type {
  StorageDatabase,
  StorageDatabaseMigrationJournalEntry,
  StorageDatabaseStartupRows,
  StoredChatStateRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
} from "../../../packages/types/storageDatabase";
import type { MigrationMeta } from "drizzle-orm/migrator";

/** 10.5.4 的数据库版本；仅支持这一条来源边。 */
const SOURCE_SCHEMA_VERSION: number = 7;
/** 10.5.4 白名单中必须存在的翻译权限字段。 */
const SOURCE_PERMISSION: string = "isCanControllJATranslatePermission";
/** 10.5.4 群状态中可选的日语翻译开关。 */
const SOURCE_SWITCH: string = "isJATranslationEnabled";

/** 先核验已发布 v7 的精确 Drizzle 谱系；缺项、未知项和更旧版本均拒绝。 */
function assertSourceLineage(database: StorageDatabase, source: string): void {
  const migrations: MigrationMeta[] = readMigrationFiles({ migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
  const last: MigrationMeta | undefined = migrations.at(-1);
  if (last?.folderMillis !== IDENTITY_DATABASE_TRANSLATE_MIGRATION_CREATED_AT || last.hash !== IDENTITY_DATABASE_TRANSLATE_MIGRATION_HASH) {
    return invalidInput(source, "__drizzle_migrations", "the current translation migration files");
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
    return invalidInput(source, "__drizzle_migrations", "the exact 10.5.4 schema v7 lineage");
  }
}

/** 仅改名明确存在的源字段；冲突、缺失必填权限或非法值均不修复。 */
function renamedObject(value: unknown, source: string, required: boolean): Record<string, unknown> {
  if (!isPlainRecord(value)) return invalidInput(source, "$", "an object");
  const oldKey: string = required ? SOURCE_PERMISSION : SOURCE_SWITCH;
  const newKey: string = required ? "isCanControllTranslatePermission" : "isTranslationEnabled";
  if (newKey in value || (required && !(oldKey in value))) {
    return invalidInput(source, "$", "only 10.5.4 field names with the required translation permission");
  }
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) result[key === oldKey ? newKey : key] = field;
  return result;
}

/** 迁移前校验所有受影响行，使用当前严格解码器验证改名后的完整形态。 */
function assertSourceRows(database: StorageDatabase, source: string): void {
  for (const row of database.$client.query<StoredIdentityPolicyRow, []>(
    "SELECT id, json(data) AS data FROM whitelist_entries ORDER BY id;"
  ).iterate()) {
    const path: string = `${source}:whitelist_entries[${row.id}].data`;
    const value: unknown = parseJsonInput(row.data, path);
    if (!isPlainRecord(value)) return invalidInput(path, "$", "an object");
    decodeWhitelistEntryData(JSON.stringify({ ...value, permissions: renamedObject(value.permissions, path, true) }), path);
  }
  const rows: StoredChatStateRow[] = [];
  for (const row of database.$client.query<StoredChatStateRow, []>(
    "SELECT chat_id AS chatId, json(data) AS data FROM chat_states ORDER BY chat_id;"
  ).iterate()) {
    const path: string = `${source}:chat_states[${row.chatId}].data`;
    rows.push({ chatId: row.chatId, data: JSON.stringify(renamedObject(parseJsonInput(row.data, path), path, false)) });
  }
  decodeStoredChatStates(rows, source);
}

/** 在独立暂存副本执行唯一的 v7 → v8 事务迁移，完成后校验全部业务表与引用。 */
export function migrateTranslationDatabase(database: StorageDatabase, source: string): void {
  const version: number = readStorageSchemaVersion({ metadata: readStorageDatabaseSchemaMetadata(database) }, source);
  if (version !== SOURCE_SCHEMA_VERSION) return invalidInput(source, "storage_metadata", "schema version 7 from release 10.5.4");
  assertSourceLineage(database, source);
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  assertSourceRows(database, source);
  migrate(database, { migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
  if (readStorageSchemaVersion({ metadata: readStorageDatabaseSchemaMetadata(database) }, source) !== IDENTITY_DATABASE_SCHEMA_VERSION) {
    return invalidInput(source, "storage_metadata", "the current schema version");
  }
  assertStorageDatabaseMigrationLineage(database, source);
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  assertStoredIdentityPolicies(database, source);
  const rows: StorageDatabaseStartupRows = readStorageDatabaseStartupRows(database);
  decodeStoredChatStates(rows.chatStates, source);
  decodeStoredChatQa(rows.chatQa, source);
  for (const row of database.$client.query<StoredPendingRemovalRow, []>(
    "SELECT removal_id AS removalId, json(data) AS data FROM pending_blocked_removals ORDER BY removal_id;"
  ).iterate()) {
    assertPendingRemovalBlocklistReferences(database, decodeStoredPendingRemovals([row], source).values, source);
  }
  const checkpoint: Readonly<{ busy: number; log: number; checkpointed: number }> | null = database.$client
    .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE);")
    .get();
  if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
    return invalidInput(source, "wal_checkpoint", "a complete checkpoint without busy readers or writers");
  }
}
