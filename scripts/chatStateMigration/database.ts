/** 共享 SQLite 的 v3/v4 谱系检查、群状态写入与迁移后核验。 */

import {
  IDENTITY_DATABASE_CHAT_STATE_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_CHAT_STATE_MIGRATION_HASH,
  IDENTITY_DATABASE_CURRENT_BASE_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH,
} from "../../packages/consts/identityStorage";
import {
  assertStorageDatabaseBaseJsonbStorage,
  assertStorageDatabaseJsonbStorage,
  readStorageDatabaseBaseRows,
  readStorageDatabaseRows,
} from "../../packages/database/interact/inspection";
import {
  migrateStorageDatabaseSchema,
  readStorageDatabaseMigrationJournal,
} from "../../packages/database/interact/migration";
import { commitStorageDatabaseChanges } from
  "../../packages/database/interact/transaction";
import {
  assertPendingRemovalBlocklistReferences,
  decodeStoredChatStates,
  decodeStoredPendingRemovals,
  readStorageSchemaVersion,
  validateStoredIdentityPolicies,
} from "../../packages/database/validation/storageRows";
import type { ValidatedIdentityPolicyRows } from
  "../../packages/database/validation/storageRows";
import type {
  StorageDatabase,
  StorageDatabaseBaseRows,
  StorageDatabaseChange,
  StorageDatabaseMigrationJournalEntry,
  StorageDatabaseRows,
  StoredChatStateRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
} from "../../packages/types/storageDatabase";
import { sameChatRows } from "./stateSource";
import type { ChatStateMigrationSource } from "./stateSource";

const PREVIOUS_SCHEMA_VERSION: number = 3;
const CURRENT_SCHEMA_VERSION: number = 4;

export interface ChatStateDatabaseInspection {
  readonly version: 3 | 4;
  readonly baseRows: StorageDatabaseBaseRows;
  readonly chatRows: readonly StoredChatStateRow[];
}

export type ChatStateMigrationStatus = "pending" | "alreadyMigrated";

function isMigrationEntry(
  entry: StorageDatabaseMigrationJournalEntry | undefined,
  createdAt: number,
  hash: string
): boolean {
  return entry?.createdAt === createdAt && entry.hash === hash;
}

function isSchemaV3Journal(
  rows: readonly StorageDatabaseMigrationJournalEntry[]
): boolean {
  const permission: StorageDatabaseMigrationJournalEntry | undefined = rows.at(-1);
  if (!isMigrationEntry(
    permission,
    IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT,
    IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH
  )) return false;
  if (rows.length === 2) {
    return isMigrationEntry(
      rows[0],
      IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_CURRENT_BASE_MIGRATION_HASH
    );
  }
  return rows.length === 3 &&
    isMigrationEntry(
      rows[0],
      IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_TEXT_MIGRATION_HASH
    ) &&
    isMigrationEntry(
      rows[1],
      IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_JSONB_MIGRATION_HASH
    );
}

function isSchemaV4Journal(
  rows: readonly StorageDatabaseMigrationJournalEntry[]
): boolean {
  return rows.length >= 3 &&
    isMigrationEntry(
      rows.at(-1),
      IDENTITY_DATABASE_CHAT_STATE_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_CHAT_STATE_MIGRATION_HASH
    ) &&
    isSchemaV3Journal(rows.slice(0, -1));
}

/** 同时识别已部署 v3 两种合法谱系与当前 v4，未知历史一律拒绝。 */
export function inspectChatStateDatabase(
  database: StorageDatabase,
  source: string
): ChatStateDatabaseInspection {
  assertStorageDatabaseBaseJsonbStorage(database, source);
  const baseRows: StorageDatabaseBaseRows = readStorageDatabaseBaseRows(database);
  const policies: ValidatedIdentityPolicyRows = validateStoredIdentityPolicies(
    baseRows,
    source
  );
  assertPendingRemovalBlocklistReferences(
    decodeStoredPendingRemovals(baseRows.removals, source).values,
    policies.blocklistIds,
    source
  );
  const version: number = readStorageSchemaVersion(baseRows, source);
  const journal: readonly StorageDatabaseMigrationJournalEntry[] =
    readStorageDatabaseMigrationJournal(database);
  if (version === PREVIOUS_SCHEMA_VERSION) {
    if (!isSchemaV3Journal(journal)) {
      throw new Error(
        `${source}: Drizzle migration journal does not match a supported schema v3 lineage.`
      );
    }
    return { version: 3, baseRows, chatRows: [] };
  }
  if (version !== CURRENT_SCHEMA_VERSION || !isSchemaV4Journal(journal)) {
    throw new Error(`${source}: expected the exact deployed schema v3 or v4 migration lineage.`);
  }
  assertStorageDatabaseJsonbStorage(database, source);
  const rows: StorageDatabaseRows = readStorageDatabaseRows(database);
  decodeStoredChatStates(rows.chatStates, source);
  return { version: 4, baseRows, chatRows: rows.chatStates };
}

function businessRowMap(
  rows: readonly (StoredIdentityPolicyRow | StoredPendingRemovalRow)[]
): Map<number, string> {
  const result: Map<number, string> = new Map<number, string>();
  for (const row of rows) {
    const id: number = "id" in row ? row.id : row.removalId;
    result.set(id, row.data);
  }
  return result;
}

function assertBaseBusinessRowsUnchanged(
  before: StorageDatabaseBaseRows,
  after: StorageDatabaseBaseRows,
  source: string
): void {
  for (const [label, left, right] of [
    ["whitelist_entries", before.whitelist, after.whitelist],
    ["blocklist_entries", before.blocklist, after.blocklist],
    ["pending_blocked_removals", before.removals, after.removals],
  ] as const) {
    const leftMap: Map<number, string> = businessRowMap(left);
    const rightMap: Map<number, string> = businessRowMap(right);
    if (leftMap.size !== rightMap.size) {
      throw new Error(`${source}:${label} changed during chat-state migration.`);
    }
    for (const [id, data] of leftMap) {
      if (rightMap.get(id) !== data) {
        throw new Error(`${source}:${label}[${id}] changed during chat-state migration.`);
      }
    }
  }
}

/** 只读检查冷迁移是否可执行或已经完整完成。 */
export function assertChatStateMigrationReady(
  database: StorageDatabase,
  source: ChatStateMigrationSource,
  databasePath: string
): ChatStateMigrationStatus {
  const inspection: ChatStateDatabaseInspection = inspectChatStateDatabase(
    database,
    databasePath
  );
  if (source.chatRows === null) {
    if (inspection.version !== 4) {
      throw new Error(
        `${databasePath}: global-only state requires an already migrated schema v4 database.`
      );
    }
    return "alreadyMigrated";
  }
  if (inspection.version === 3) return "pending";
  if (inspection.chatRows.length === 0) return "pending";
  if (!sameChatRows(inspection.chatRows, source.chatRows)) {
    throw new Error(`${databasePath}:chat_states does not match the legacy state source.`);
  }
  return source.mainKind === "current" && source.backupKind === "current"
    ? "alreadyMigrated"
    : "pending";
}

/**
 * v3→v4 schema 与群行写入；事务已完成但 state 尚未切换时可幂等重跑。
 * @returns 本轮是否实际修改了 SQLite。
 */
export function applyChatStateDatabaseMigration(
  database: StorageDatabase,
  source: ChatStateMigrationSource,
  databasePath: string
): boolean {
  if (source.chatRows === null) {
    const inspection: ChatStateDatabaseInspection = inspectChatStateDatabase(
      database,
      databasePath
    );
    if (inspection.version !== 4) {
      throw new Error(`${databasePath}: cannot migrate without a legacy chats source.`);
    }
    return false;
  }
  const before: ChatStateDatabaseInspection = inspectChatStateDatabase(
    database,
    databasePath
  );
  let changed: boolean = false;
  if (before.version === 3) {
    migrateStorageDatabaseSchema(database);
    changed = true;
  }
  const afterSchema: ChatStateDatabaseInspection = inspectChatStateDatabase(
    database,
    databasePath
  );
  if (afterSchema.version !== 4) {
    throw new Error(`${databasePath}: schema migration did not reach version 4.`);
  }
  if (
    afterSchema.chatRows.length > 0 &&
    !sameChatRows(afterSchema.chatRows, source.chatRows)
  ) {
    throw new Error(`${databasePath}:chat_states does not match the legacy state source.`);
  }
  if (afterSchema.chatRows.length === 0 && source.chatRows.length > 0) {
    const changes: Map<number, StorageDatabaseChange> = new Map();
    for (const row of source.chatRows) changes.set(row.chatId, { data: row.data });
    commitStorageDatabaseChanges(database, {
      whitelist: new Map<number, StorageDatabaseChange>(),
      blocklist: new Map<number, StorageDatabaseChange>(),
      removals: new Map<number, StorageDatabaseChange>(),
      chatStates: changes,
    });
    changed = true;
  }
  const verified: ChatStateDatabaseInspection = inspectChatStateDatabase(
    database,
    databasePath
  );
  assertBaseBusinessRowsUnchanged(before.baseRows, verified.baseRows, databasePath);
  if (!sameChatRows(verified.chatRows, source.chatRows)) {
    throw new Error(
      `${databasePath}:chat_states verification does not match the legacy state source.`
    );
  }
  return changed;
}
