import { asc, count, gt } from "drizzle-orm";
import { BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE } from
  "../../consts/antiRaid/blocklist";
import {
  CLEAR_CONTEXT_PERMISSION_MIGRATION_CREATED_AT,
  CLEAR_CONTEXT_PERMISSION_MIGRATION_HASH,
  AI_CONTEXT_MIGRATION_CREATED_AT,
  AI_CONTEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_CHAT_QA_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_CHAT_QA_MIGRATION_HASH,
  IDENTITY_DATABASE_CHAT_STATE_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_CHAT_STATE_MIGRATION_HASH,
  IDENTITY_DATABASE_CURRENT_BASE_MIGRATION_HASH,
  IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_JSONB_MIGRATION_HASH,
  IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TEXT_MIGRATION_HASH,
  IDENTITY_DATABASE_TEMPORARY_ACTIVITY_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TEMPORARY_ACTIVITY_MIGRATION_HASH,
  IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_HASH,
  IDENTITY_DATABASE_TRANSLATE_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_TRANSLATE_MIGRATION_HASH,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT,
  IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH,
} from "../../consts/identityStorage";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodeWhitelistEntryData,
} from "../codec/identity";
import { assertTemporaryAdBypassActivity } from "../codec/temporaryAdBypass";
import { readStoredChatStates } from "./chatState";
import { readStoredChatQa } from "./chatQa";
import { blocklistEntries, permissionList } from "../schema/identityPolicy";
import {
  guardedStrictJsonbTextProjection,
  jsonbStorageClass,
  jsonbTextProjection,
} from "../schema/jsonb";
import { storageMetadata } from "../schema/metadata";
import { pendingBlockedRemovals } from "../schema/pendingRemoval";
import type { StoredTemporaryAdBypassActivity } from
  "../../types/temporaryAdBypass";
import { readStorageDatabaseMigrationJournal } from "./migration";
import { storageRowSource } from "../validation/storageRows";
import type {
  StorageDatabase,
  StorageDatabaseJsonStorageRow,
  StorageDatabaseStartupRows,
  StorageDatabaseMigrationJournalEntry,
  StoredChatStateRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalStartupRow,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";

interface ReadJsonbStorageRowOptions {
  readonly tableName: string;
  readonly columnName?: string;
  readonly nullable?: boolean;
}

interface StorageColumnDeclarationRow {
  readonly type: string;
}

interface StorageJsonbAggregateRow {
  readonly rowCount: number;
  readonly textRows: number;
  readonly blobRows: number;
  readonly invalidJsonbRows: number;
}

interface StorageDatabaseIntegrityRow {
  readonly integrity_check: string;
}

function readJsonbStorageRow(
  database: StorageDatabase,
  { tableName, columnName = "data", nullable = false }: ReadJsonbStorageRowOptions
): StorageDatabaseJsonStorageRow {
  const declaration: StorageColumnDeclarationRow | null = database.$client
    .query<StorageColumnDeclarationRow, [string, string]>(
      "SELECT type FROM pragma_table_xinfo(?1) WHERE name = ?2;"
    )
    .get(tableName, columnName);
  const aggregate: StorageJsonbAggregateRow | null = database.$client
    .query<StorageJsonbAggregateRow, []>(
      `SELECT COUNT(*) AS rowCount, ` +
      `COALESCE(SUM(typeof(${columnName}) = 'text'), 0) AS textRows, ` +
      `COALESCE(SUM(typeof(${columnName}) = 'blob'), 0) AS blobRows, ` +
      `COALESCE(SUM(json_valid(${columnName}, 8) <> 1), 0) AS invalidJsonbRows ` +
      `FROM ${tableName}${nullable ? ` WHERE ${columnName} IS NOT NULL` : ""};`
    )
    .get();
  return {
    tableName: `${tableName}.${columnName}`,
    declaredType: declaration?.type.toUpperCase() ?? null,
    rowCount: aggregate?.rowCount ?? 0,
    textRows: aggregate?.textRows ?? 0,
    blobRows: aggregate?.blobRows ?? 0,
    invalidJsonbRows: aggregate?.invalidJsonbRows ?? 0,
  };
}

/** 读取当前 schema 六张 JSONB 表的声明与存储统计。 */
function readStorageDatabaseJsonStorage(
  database: StorageDatabase
): readonly StorageDatabaseJsonStorageRow[] {
  return [
    readJsonbStorageRow(database, { tableName: "permission_list", columnName: "policy" }),
    readJsonbStorageRow(database, { tableName: "blocklist_entries" }),
    readJsonbStorageRow(database, { tableName: "pending_blocked_removals" }),
    readJsonbStorageRow(database, { tableName: "storage_metadata" }),
    readJsonbStorageRow(database, { tableName: "chat_states", columnName: "status" }),
    readJsonbStorageRow(database, { tableName: "chat_states", columnName: "ai_context", nullable: true }),
    readJsonbStorageRow(database, { tableName: "chat_qa" }),
  ];
}

function assertJsonbStorageRows(
  rows: readonly StorageDatabaseJsonStorageRow[],
  source: string,
  expectedCount: number
): void {
  if (rows.length !== expectedCount) {
    throw new Error(
      `${source}: expected JSONB storage metadata for exactly ` +
      `${expectedCount} storage tables.`
    );
  }
  for (const row of rows) {
    if (
      row.declaredType !== "BLOB" ||
      row.textRows !== 0 ||
      row.blobRows !== row.rowCount ||
      row.invalidJsonbRows !== 0
    ) {
      throw new Error(
        `${source}:${row.tableName}: expected a BLOB column containing only strict SQLite JSONB.`
      );
    }
  }
}

/** 启动与性能夹具都拒绝当前七个 JSONB 列的非严格存储。 */
export function assertStorageDatabaseJsonbStorage(
  database: StorageDatabase,
  source: string
): void {
  assertJsonbStorageRows(readStorageDatabaseJsonStorage(database), source, 7);
}

/** 启动时执行 SQLite 自身的完整性检查。 */
export function assertStorageDatabaseIntegrity(
  database: StorageDatabase,
  source: string
): void {
  const rows: StorageDatabaseIntegrityRow[] = database.$client
    .query<StorageDatabaseIntegrityRow, []>("PRAGMA integrity_check;")
    .all();
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error(`${source}: expected SQLite integrity_check to return exactly ok.`);
  }
}

function isMigrationEntry(
  entry: StorageDatabaseMigrationJournalEntry | undefined,
  createdAt: number,
  hash: string
): boolean {
  return entry?.createdAt === createdAt && entry.hash === hash;
}

function hasCurrentBaseLineage(
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

function hasSchemaV5MigrationLineage(
  rows: readonly StorageDatabaseMigrationJournalEntry[]
): boolean {
  return rows.length >= 4 &&
    isMigrationEntry(
      rows.at(-1),
      IDENTITY_DATABASE_CHAT_QA_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_CHAT_QA_MIGRATION_HASH
    ) &&
    isMigrationEntry(
      rows.at(-2),
      IDENTITY_DATABASE_CHAT_STATE_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_CHAT_STATE_MIGRATION_HASH
    ) &&
    hasCurrentBaseLineage(rows.slice(0, -2));
}

/** 当前 v10 必须包含完整谱系及清理上下文权限迁移，不接受缺项或额外项。 */
export function assertStorageDatabaseMigrationLineage(
  database: StorageDatabase,
  source: string
): void {
  const journal: readonly StorageDatabaseMigrationJournalEntry[] =
    readStorageDatabaseMigrationJournal(database, source);
  if (!isMigrationEntry(journal.at(-1), CLEAR_CONTEXT_PERMISSION_MIGRATION_CREATED_AT, CLEAR_CONTEXT_PERMISSION_MIGRATION_HASH) ||
    !isMigrationEntry(journal.at(-2), AI_CONTEXT_MIGRATION_CREATED_AT, AI_CONTEXT_MIGRATION_HASH)) {
    throw new Error(`${source}: expected the exact supported schema v10 migration lineage.`);
  }
  const rows: readonly StorageDatabaseMigrationJournalEntry[] = journal.slice(0, -2);
  if (
    rows.length < 7 ||
    !isMigrationEntry(
      rows.at(-1),
      IDENTITY_DATABASE_TRANSLATE_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_TRANSLATE_MIGRATION_HASH
    ) ||
    !isMigrationEntry(
      rows.at(-2),
      IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_HASH
    )
  ) {
    throw new Error(`${source}: expected the exact supported schema v10 migration lineage.`);
  }
  const v6Rows: readonly StorageDatabaseMigrationJournalEntry[] =
    rows.slice(0, -2);
  if (
    v6Rows.length < 5 ||
    !isMigrationEntry(
      v6Rows.at(-1),
      IDENTITY_DATABASE_TEMPORARY_ACTIVITY_MIGRATION_CREATED_AT,
      IDENTITY_DATABASE_TEMPORARY_ACTIVITY_MIGRATION_HASH
    ) ||
    !hasSchemaV5MigrationLineage(v6Rows.slice(0, -1))
  ) {
    throw new Error(`${source}: expected the exact supported schema v10 migration lineage.`);
  }
}

/** 流式严格解码两张身份表，并用 SQL 拒绝跨表重复主键。 */
export function assertStoredIdentityPolicies(
  database: StorageDatabase,
  source: string
): void {
  const overlap: { readonly id: number } | null = database.$client
    .query<{ readonly id: number }, []>(
      "SELECT permission_list.id AS id FROM permission_list " +
      "INNER JOIN blocklist_entries USING (id) LIMIT 1;"
    )
    .get();
  if (overlap !== null) {
    throw new Error(
      `${source}:permission_list/blocklist_entries[$.id]: expected disjoint primary keys.`
    );
  }
  const temporaryOverlap: { readonly id: number } | null = database.$client
    .query<{ readonly id: number }, []>(
      "SELECT temporary_ad_bypass_entries.id AS id FROM temporary_ad_bypass_entries " +
      "INNER JOIN blocklist_entries USING (id) LIMIT 1;"
    )
    .get();
  if (temporaryOverlap !== null) {
    throw new Error(
      `${source}:temporary_ad_bypass_entries/blocklist_entries[$.id]: ` +
      "expected disjoint primary keys."
    );
  }
  const whitelistRows: IterableIterator<StoredIdentityPolicyRow> = database.$client
    .query<StoredIdentityPolicyRow, []>(
      "SELECT id, json(policy) AS data FROM permission_list ORDER BY id ASC;"
    )
    .iterate();
  for (const row of whitelistRows) {
    const path: string = storageRowSource(source, "permission_list", row.id);
    assertTelegramIdentityId(row.id, path);
    decodeWhitelistEntryData(row.data, path);
  }
  const blocklistRows: IterableIterator<StoredIdentityPolicyRow> = database.$client
    .query<StoredIdentityPolicyRow, []>(
      "SELECT id, json(data) AS data FROM blocklist_entries ORDER BY id ASC;"
    )
    .iterate();
  for (const row of blocklistRows) {
    const path: string = storageRowSource(source, "blocklist_entries", row.id);
    assertTelegramIdentityId(row.id, path);
    decodeBlocklistEntryData(row.data, path);
  }
  const temporaryRows: IterableIterator<{
    readonly id: number;
    readonly adBypass: number;
    readonly adBypassGrantedAt: number | null;
    readonly qualifiedDays: number;
    readonly sendCount: number;
    readonly countedAt: number;
    readonly qualifiedAt: number | null;
  }> = database.$client.query<{
    readonly id: number;
    readonly adBypass: number;
    readonly adBypassGrantedAt: number | null;
    readonly qualifiedDays: number;
    readonly sendCount: number;
    readonly countedAt: number;
    readonly qualifiedAt: number | null;
  }, []>(
    "SELECT id, ad_bypass AS adBypass, ad_bypass_granted_at AS adBypassGrantedAt, " +
    "qualified_days AS qualifiedDays, send_count AS sendCount, " +
    "counted_at AS countedAt, qualified_at AS qualifiedAt " +
    "FROM temporary_ad_bypass_entries ORDER BY id ASC;"
  ).iterate();
  for (const row of temporaryRows) {
    const path: string = `${source}:temporary_ad_bypass_entries[${row.id}]`;
    assertTelegramIdentityId(row.id, path);
    if (row.adBypass !== 0 && row.adBypass !== 1) {
      throw new Error(`${path}.ad_bypass: expected SQLite integer 0 or 1.`);
    }
    const activity: StoredTemporaryAdBypassActivity = {
      id: row.id,
      adBypass: row.adBypass === 1,
      adBypassGrantedAt: row.adBypassGrantedAt,
      qualifiedDays: row.qualifiedDays,
      sendCount: row.sendCount,
      countedAt: row.countedAt,
      qualifiedAt: row.qualifiedAt,
    };
    assertTemporaryAdBypassActivity(activity, path);
  }
}

/**
 * 生产启动的版本前置闸只扫描单行 metadata；版本通过后再检查当前六表与正文。
 */
export function assertStorageDatabaseStartupJsonbStorage(
  database: StorageDatabase,
  source: string
): void {
  assertJsonbStorageRows([
    readJsonbStorageRow(database, {
      tableName: "storage_metadata",
    }),
  ], source, 1);
}

/**
 * 只读 schema 版本那一行。启动必须先确认版本、再查询当前版本的业务表，避免
 * 旧库先以缺表错误失败而掩盖明确的版本诊断。
 */
export function readStorageDatabaseSchemaMetadata(
  database: StorageDatabase
): readonly StoredStorageMetadataRow[] {
  return database
    .select({ key: storageMetadata.key, data: jsonbTextProjection(storageMetadata.data) })
    .from(storageMetadata)
    .all();
}

/**
 * 生产启动读取：名单只做 COUNT；群状态与问答只为恢复热缓存读取，不在这里校验。
 * 调用方必须已用 readStorageDatabaseSchemaMetadata 确认过 schema 版本——本函数
 * 查询 `chat_states` 与 `chat_qa`，版本不符的库不得进入这里。
 */
export function readStorageDatabaseStartupRows(
  database: StorageDatabase
): StorageDatabaseStartupRows {
  const permissionEntryCount: number = database
    .select({ value: count() }).from(permissionList).get()?.value ?? 0;
  const blocklistEntryCount: number = database
    .select({ value: count() }).from(blocklistEntries).get()?.value ?? 0;
  const storedChatStates: readonly StoredChatStateRow[] = readStoredChatStates(database);
  return {
    permissionEntryCount,
    blocklistEntryCount,
    chatStates: storedChatStates,
    // 全表读而不分页：每群上限 15 条、受管群上限 STATE_MANAGED_CHAT_LIMIT，
    // 整张表因此恒定不超过 375 行，不存在需要游标的规模。
    chatQa: readStoredChatQa(database),
  };
}

/**
 * 启动按主键游标读取一页 outbox；存储形态与严格 JSONB 结果随正文同页投影。
 * null 游标读取第一页，后续页只读取更大的 removal_id，不使用随表增长变慢的 OFFSET。
 */
export function readStorageDatabasePendingRemovalPage(
  database: StorageDatabase,
  afterRemovalId: number | null
): readonly StoredPendingRemovalStartupRow[] {
  if (afterRemovalId === null) {
    return database
      .select({
        removalId: pendingBlockedRemovals.removalId,
        data: guardedStrictJsonbTextProjection(pendingBlockedRemovals.data),
        storageClass: jsonbStorageClass(pendingBlockedRemovals.data),
      })
      .from(pendingBlockedRemovals)
      .orderBy(asc(pendingBlockedRemovals.removalId))
      .limit(BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE)
      .all();
  }
  return database
    .select({
      removalId: pendingBlockedRemovals.removalId,
      data: guardedStrictJsonbTextProjection(pendingBlockedRemovals.data),
      storageClass: jsonbStorageClass(pendingBlockedRemovals.data),
    })
    .from(pendingBlockedRemovals)
    .where(gt(pendingBlockedRemovals.removalId, afterRemovalId))
    .orderBy(asc(pendingBlockedRemovals.removalId))
    .limit(BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE)
    .all();
}
