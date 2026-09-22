import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES } from "../../../packages/consts/antiRaid/blocklist";
import {
  IDENTITY_DATABASE_MIGRATIONS_DIR, IDENTITY_DATABASE_SCHEMA_VERSION,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT, IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT, IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  H_IMAGE_ADD_PERMISSION_MIGRATION_CREATED_AT, H_IMAGE_ADD_PERMISSION_MIGRATION_HASH,
} from "../../../packages/consts/identityStorage";
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

/** 校验上次迁移产出的完整 v10 谱系；未知、过旧和额外条目一律拒绝。 */
function assertSourceLineage(database: StorageDatabase, source: string): void {
  const migrations: MigrationMeta[] = readMigrationFiles({ migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
  const last: MigrationMeta | undefined = migrations.at(-1);
  if (last?.folderMillis !== H_IMAGE_ADD_PERMISSION_MIGRATION_CREATED_AT || last.hash !== H_IMAGE_ADD_PERMISSION_MIGRATION_HASH) {
    return invalidInput(source, "__drizzle_migrations", "the current /h_image add permission migration files");
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
    return invalidInput(source, "__drizzle_migrations", "the exact schema v10 lineage");
  }
}

export interface HImageAddPermissionMigrationCounts {
  readonly enabledPermissions: number;
  readonly disabledPermissions: number;
}

/** 旧权限必须逐项完整且为布尔值；仅原有全部权限开启的成员获得新权限。 */
function inspectSourcePermissions(database: StorageDatabase, source: string): HImageAddPermissionMigrationCounts {
  let enabledPermissions: number = 0;
  let disabledPermissions: number = 0;
  for (const row of database.$client.query<StoredIdentityPolicyRow, []>(
    "SELECT id, json(policy) AS data FROM permission_list ORDER BY id;"
  ).iterate()) {
    const path: string = `${source}:permission_list[${row.id}].policy`;
    const value: unknown = parseJsonInput(row.data, path);
    if (!isPlainRecord(value) || !isPlainRecord(value.permissions) || "isCanAddHImage" in value.permissions) {
      return invalidInput(path, "$.permissions", "the complete schema v10 permissions object");
    }
    const allEnabled: boolean = Object.values(value.permissions).every((field: unknown): boolean => field === true);
    decodeWhitelistEntryData(JSON.stringify({ ...value, permissions: { ...value.permissions, isCanAddHImage: allEnabled } }), path);
    if (allEnabled) enabledPermissions++;
    else disabledPermissions++;
  }
  return { enabledPermissions, disabledPermissions };
}

/** 当前格式的完整只读门禁；所有持久化领域均通过后才允许输出 ready 清单。 */
function validateCurrentDatabase(database: StorageDatabase, source: string): void {
  assertStorageDatabaseMigrationLineage(database, source);
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  assertStoredIdentityPolicies(database, source);
  const rows: ReturnType<typeof readStorageDatabaseStartupRows> = readStorageDatabaseStartupRows(database);
  decodeStoredChatStates(rows.chatStates, source);
  decodeStoredChatQa(rows.chatQa, source);
  readStoredAiContexts(database, source);
  let removalCount: number = 0;
  for (const row of database.$client.query<StoredPendingRemovalRow, []>(
    "SELECT removal_id AS removalId, json(data) AS data FROM pending_blocked_removals ORDER BY removal_id;"
  ).iterate()) {
    if (++removalCount > BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
      return invalidInput(source, "pending_blocked_removals", `at most ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES} rows`);
    }
    assertPendingRemovalBlocklistReferences(database, decodeStoredPendingRemovals([row], source).values, source);
  }
}

/** 独立副本中执行 v10 → v11；只增加权限位与迁移版本，不清理任何群聊内容。 */
export function migrateHImageAddPermissionDatabase(database: StorageDatabase, source: string): HImageAddPermissionMigrationCounts {
  const version: number = readStorageSchemaVersion({ metadata: readStorageDatabaseSchemaMetadata(database) }, source);
  if (version !== 10) return invalidInput(source, "storage_metadata", "schema version 10 from the preceding migration");
  assertSourceLineage(database, source);
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  const counts: HImageAddPermissionMigrationCounts = inspectSourcePermissions(database, source);
  migrate(database, { migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
  if (readStorageSchemaVersion({ metadata: readStorageDatabaseSchemaMetadata(database) }, source) !== IDENTITY_DATABASE_SCHEMA_VERSION) {
    return invalidInput(source, "storage_metadata", "the current schema version");
  }
  validateCurrentDatabase(database, source);
  const checkpoint: Readonly<{ busy: number; log: number; checkpointed: number }> | null = database.$client
    .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE);").get();
  if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) return invalidInput(source, "wal_checkpoint", "a complete checkpoint without busy readers or writers");
  return counts;
}
