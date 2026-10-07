import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  IDENTITY_DATABASE_MIGRATIONS_DIR,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT, IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT, IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  CHAT_PERSONA_REMOVAL_MIGRATION_CREATED_AT, CHAT_PERSONA_REMOVAL_MIGRATION_HASH,
  TIME_ZONE_MARKER_MIGRATION_CREATED_AT, TIME_ZONE_MARKER_MIGRATION_HASH,
} from "../../../packages/consts/identityStorage";
import { decodeWhitelistEntryData } from "../../../packages/database/codec/identity";
import { readStorageDatabaseMigrationJournal } from "../../../packages/database/interact/migration";
import {
  assertStorageDatabaseIntegrity, assertStorageDatabaseJsonbStorage, readStorageDatabaseSchemaMetadata,
} from "../../../packages/database/interact/inspection";
import { validateStorageDatabase } from "../../../packages/database/interact/validation";
import { readStorageSchemaVersion } from "../../../packages/database/validation/storageRows";
import { invalidInput, parseJsonInput } from "../../../packages/libs/inputValidation";
import { isPlainRecord } from "../../../packages/libs/record";
import type { StorageDatabase, StorageDatabaseMigrationJournalEntry, StoredIdentityPolicyRow } from "../../../packages/types/storageDatabase";
import type { MigrationMeta } from "drizzle-orm/migrator";

/** 本次直接迁移接受的源 schema 版本；产物版本为 IDENTITY_DATABASE_SCHEMA_VERSION。 */
export const CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION: number = 11;

/** 本次直接迁移直接移除的权限位。 */
const REMOVED_PERMISSION_KEY: string = "isCanConfigAiPrompt";

/** 校验上次迁移产出的完整源谱系；未知、过旧和额外条目一律拒绝。 */
function assertSourceLineage(database: StorageDatabase, source: string): void {
  const migrations: MigrationMeta[] = readMigrationFiles({ migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
  const removal: MigrationMeta | undefined = migrations.at(-2);
  const marker: MigrationMeta | undefined = migrations.at(-1);
  if (
    removal?.folderMillis !== CHAT_PERSONA_REMOVAL_MIGRATION_CREATED_AT || removal.hash !== CHAT_PERSONA_REMOVAL_MIGRATION_HASH ||
    marker?.folderMillis !== TIME_ZONE_MARKER_MIGRATION_CREATED_AT || marker.hash !== TIME_ZONE_MARKER_MIGRATION_HASH
  ) {
    return invalidInput(source, "__drizzle_migrations", "the current chat persona removal and time zone marker migration files");
  }
  const expected: readonly StorageDatabaseMigrationJournalEntry[] = migrations.slice(0, -2).map(
    (entry: MigrationMeta): StorageDatabaseMigrationJournalEntry => ({ createdAt: entry.folderMillis, hash: entry.hash })
  );
  const historical: readonly StorageDatabaseMigrationJournalEntry[] = [
    { createdAt: IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT, hash: IDENTITY_DATABASE_TEXT_MIGRATION_HASH },
    { createdAt: IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT, hash: IDENTITY_DATABASE_JSONB_MIGRATION_HASH },
    ...expected.slice(1),
  ];
  const actual: string = JSON.stringify(readStorageDatabaseMigrationJournal(database, source));
  if (actual !== JSON.stringify(expected) && actual !== JSON.stringify(historical)) {
    return invalidInput(source, "__drizzle_migrations", "the exact schema v11 lineage");
  }
}

export interface ChatPersonaRemovalMigrationCounts {
  /** 源库中带群人设的群数；其中状态为空的群整行删除，另计入 removedEmptyChats。 */
  readonly removedPersonas: number;
  /** 状态为空、仅因群人设而存在、随列一起删除的群行数。 */
  readonly removedEmptyChats: number;
  /** 去掉 isCanConfigAiPrompt 权限位的身份数。 */
  readonly removedPermissions: number;
}

/** 源权限必须是完整的源 schema 形态且带布尔 isCanConfigAiPrompt；去掉该位后按当前格式严格解码。 */
function inspectSourcePermissions(database: StorageDatabase, source: string): number {
  let removedPermissions: number = 0;
  for (const row of database.$client.query<StoredIdentityPolicyRow, []>(
    "SELECT id, json(policy) AS data FROM permission_list ORDER BY id;"
  ).iterate()) {
    const path: string = `${source}:permission_list[${row.id}].policy`;
    const value: unknown = parseJsonInput(row.data, path);
    if (!isPlainRecord(value) || !isPlainRecord(value.permissions) || typeof value.permissions[REMOVED_PERMISSION_KEY] !== "boolean") {
      return invalidInput(path, "$.permissions", "the complete schema v11 permissions object");
    }
    const { [REMOVED_PERMISSION_KEY]: _removed, ...permissions }: Readonly<Record<string, unknown>> = value.permissions;
    decodeWhitelistEntryData(JSON.stringify({ ...value, permissions }), path);
    removedPermissions++;
  }
  return removedPermissions;
}

/** 只允许删除仅靠人设存在的空状态行；其余空状态（含带 AI 上下文的空状态）一律拒绝。 */
function inspectSourceChatStates(database: StorageDatabase, source: string): Omit<ChatPersonaRemovalMigrationCounts, "removedPermissions"> {
  const invalid: { readonly chatId: number } | null = database.$client
    .query<{ readonly chatId: number }, []>(
      "SELECT chat_id AS chatId FROM chat_states WHERE json(status) = '{}' " +
      "AND (ai_context IS NOT NULL OR ai_persona IS NULL) LIMIT 1;"
    )
    .get();
  if (invalid !== null) {
    return invalidInput(`${source}:chat_states[${invalid.chatId}].status`, "$", "a non-empty state or a persona-only empty state without AI context");
  }
  const counts: Readonly<{ removedPersonas: number | null; removedEmptyChats: number | null }> | null = database.$client
    .query<{ removedPersonas: number | null; removedEmptyChats: number | null }, []>(
      "SELECT sum(ai_persona IS NOT NULL) AS removedPersonas, sum(json(status) = '{}') AS removedEmptyChats FROM chat_states;"
    )
    .get();
  return { removedPersonas: counts?.removedPersonas ?? 0, removedEmptyChats: counts?.removedEmptyChats ?? 0 };
}

/**
 * 独立副本中执行源 schema → 当前 schema：直接删除 chat_states.ai_persona 列与 isCanConfigAiPrompt
 * 权限位，状态为空、仅因群人设而存在的群行随之删除；其余群状态、AI 上下文与权限原样保留；并写入
 * Asia/Tokyo 时区标记（源 schema 的日历固定为东京）。产物须通过与生产启动相同的完整校验
 * （validateStorageDatabase）才返回，调用方须已在本线程接管 Asia/Tokyo。
 */
export function migrateChatPersonaRemovalDatabase(database: StorageDatabase, source: string): ChatPersonaRemovalMigrationCounts {
  const version: number = readStorageSchemaVersion({ metadata: readStorageDatabaseSchemaMetadata(database) }, source);
  if (version !== CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION) return invalidInput(source, "storage_metadata", `schema version ${CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION} from the preceding migration`);
  assertSourceLineage(database, source);
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  const removedPermissions: number = inspectSourcePermissions(database, source);
  const chatStates: Omit<ChatPersonaRemovalMigrationCounts, "removedPermissions"> = inspectSourceChatStates(database, source);
  migrate(database, { migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
  validateStorageDatabase(database, source);
  const checkpoint: Readonly<{ busy: number; log: number; checkpointed: number }> | null = database.$client
    .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE);").get();
  if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) return invalidInput(source, "wal_checkpoint", "a complete checkpoint without busy readers or writers");
  return { ...chatStates, removedPermissions };
}
