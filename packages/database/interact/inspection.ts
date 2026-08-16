import { asc, count, eq, gt, ne } from "drizzle-orm";
import { BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE } from
  "../../consts/antiRaid/blocklist";
import { chatStates } from "../schema/chatState";
import { blocklistEntries, whitelistEntries } from "../schema/identityPolicy";
import {
  guardedStrictJsonbTextProjection,
  jsonbStorageClass,
  jsonbTextProjection,
  strictJsonbValidity,
} from "../schema/jsonb";
import { storageMetadata } from "../schema/metadata";
import { pendingBlockedRemovals } from "../schema/pendingRemoval";
import type {
  StorageDatabase,
  StorageDatabaseBaseRows,
  StorageDatabaseJsonStorageRow,
  StorageDatabaseRows,
  StorageDatabaseStartupRows,
  StoredChatStateRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
  StoredPendingRemovalStartupRow,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";
import type { AnySQLiteColumn, AnySQLiteTable } from "drizzle-orm/sqlite-core";

interface ReadJsonbStorageRowOptions {
  readonly tableName: string;
  readonly table: AnySQLiteTable;
  readonly data: AnySQLiteColumn;
}

function readJsonbStorageRow(
  database: StorageDatabase,
  { tableName, table, data }: ReadJsonbStorageRowOptions
): StorageDatabaseJsonStorageRow {
  const rowCount: number = database.select({ value: count() }).from(table).get()?.value ?? 0;
  const textRows: number = database.select({ value: count() }).from(table)
    .where(eq(jsonbStorageClass(data), "text")).get()?.value ?? 0;
  const blobRows: number = database.select({ value: count() }).from(table)
    .where(eq(jsonbStorageClass(data), "blob")).get()?.value ?? 0;
  const invalidJsonbRows: number = database.select({ value: count() }).from(table)
    .where(ne(strictJsonbValidity(data), 1)).get()?.value ?? 0;
  return {
    tableName,
    declaredType: data.getSQLType().toUpperCase(),
    rowCount,
    textRows,
    blobRows,
    invalidJsonbRows,
  };
}

/** 读取 v3 与 v4 共用的四张 JSONB 表；冷迁移不得先查询尚未创建的 chat_states。 */
export function readStorageDatabaseBaseJsonStorage(
  database: StorageDatabase
): readonly StorageDatabaseJsonStorageRow[] {
  return [
    readJsonbStorageRow(database, {
      tableName: "whitelist_entries",
      table: whitelistEntries,
      data: whitelistEntries.data,
    }),
    readJsonbStorageRow(database, {
      tableName: "blocklist_entries",
      table: blocklistEntries,
      data: blocklistEntries.data,
    }),
    readJsonbStorageRow(database, {
      tableName: "pending_blocked_removals",
      table: pendingBlockedRemovals,
      data: pendingBlockedRemovals.data,
    }),
    readJsonbStorageRow(database, {
      tableName: "storage_metadata",
      table: storageMetadata,
      data: storageMetadata.data,
    }),
  ];
}

/** 读取当前全部 JSONB 表；仅供显式冷迁移逐表核验。 */
export function readStorageDatabaseJsonStorage(
  database: StorageDatabase
): readonly StorageDatabaseJsonStorageRow[] {
  return [
    ...readStorageDatabaseBaseJsonStorage(database),
    readJsonbStorageRow(database, {
      tableName: "chat_states",
      table: chatStates,
      data: chatStates.data,
    }),
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
        `${source}:${row.tableName}.data: expected a BLOB column containing only strict SQLite JSONB.`
      );
    }
  }
}

/** 冷迁移校验 v3 与 v4 共用表，不访问 v3 尚不存在的 chat_states。 */
export function assertStorageDatabaseBaseJsonbStorage(
  database: StorageDatabase,
  source: string
): void {
  assertJsonbStorageRows(readStorageDatabaseBaseJsonStorage(database), source, 4);
}

/** 显式冷迁移拒绝五张表的列声明、存储类型或内容不是严格 JSONB。 */
export function assertStorageDatabaseJsonbStorage(
  database: StorageDatabase,
  source: string
): void {
  assertJsonbStorageRows(readStorageDatabaseJsonStorage(database), source, 5);
}

/**
 * 生产启动只扫描单行 metadata。outbox 改由 2048 条 keyset 分页随正文逐行核对，
 * 名单和群状态由当前格式的写入边界把关。
 */
export function assertStorageDatabaseStartupJsonbStorage(
  database: StorageDatabase,
  source: string
): void {
  assertJsonbStorageRows([
    readJsonbStorageRow(database, {
      tableName: "storage_metadata",
      table: storageMetadata,
      data: storageMetadata.data,
    }),
  ], source, 1);
}

/**
 * 只读 schema 版本那一行。单独成边界是因为**启动必须先确认版本、再碰按版本才
 * 存在的表**：`chat_states` 是 v4 才建的，跟着 startup rows 一起查会让未迁移的
 * v3 库先抛 `no such table: chat_states`，把「你还没跑冷迁移」这条真正的结论盖掉。
 * storage_metadata 是 v3/v4 共用表，因此这一句在两代库上都读得动。
 */
export function readStorageDatabaseSchemaMetadata(
  database: StorageDatabase
): readonly StoredStorageMetadataRow[] {
  return database
    .select({ key: storageMetadata.key, data: jsonbTextProjection(storageMetadata.data) })
    .from(storageMetadata)
    .all();
}

/** 读取 v3/v4 共用原始行；显式迁移在建 chat_states 前调用。 */
export function readStorageDatabaseBaseRows(
  database: StorageDatabase
): StorageDatabaseBaseRows {
  const whitelist: StoredIdentityPolicyRow[] = database
    .select({ id: whitelistEntries.id, data: jsonbTextProjection(whitelistEntries.data) })
    .from(whitelistEntries)
    .all();
  const blocklist: StoredIdentityPolicyRow[] = database
    .select({ id: blocklistEntries.id, data: jsonbTextProjection(blocklistEntries.data) })
    .from(blocklistEntries)
    .all();
  const removals: StoredPendingRemovalRow[] = database
    .select({
      removalId: pendingBlockedRemovals.removalId,
      data: jsonbTextProjection(pendingBlockedRemovals.data),
    })
    .from(pendingBlockedRemovals)
    .all();
  const metadata: readonly StoredStorageMetadataRow[] =
    readStorageDatabaseSchemaMetadata(database);
  return { whitelist, blocklist, removals, metadata };
}

/** 显式冷迁移读取全部原始行；严格业务解码由调用层按来源路径完成。 */
export function readStorageDatabaseRows(
  database: StorageDatabase
): StorageDatabaseRows {
  const base: StorageDatabaseBaseRows = readStorageDatabaseBaseRows(database);
  const storedChatStates: StoredChatStateRow[] = database
    .select({ chatId: chatStates.chatId, data: jsonbTextProjection(chatStates.data) })
    .from(chatStates)
    .all();
  return { ...base, chatStates: storedChatStates };
}

/**
 * 生产启动读取：名单只做 COUNT；群状态只为恢复热缓存读取，不在这里校验。
 * 调用方必须已用 readStorageDatabaseSchemaMetadata 确认过 schema 版本——本函数
 * 查询 `chat_states`，在未迁移的库上只会以缺表报错。
 */
export function readStorageDatabaseStartupRows(
  database: StorageDatabase
): StorageDatabaseStartupRows {
  const whitelistEntryCount: number = database
    .select({ value: count() }).from(whitelistEntries).get()?.value ?? 0;
  const blocklistEntryCount: number = database
    .select({ value: count() }).from(blocklistEntries).get()?.value ?? 0;
  const storedChatStates: StoredChatStateRow[] = database
    .select({ chatId: chatStates.chatId, data: jsonbTextProjection(chatStates.data) })
    .from(chatStates)
    .all();
  return {
    whitelistEntryCount,
    blocklistEntryCount,
    chatStates: storedChatStates,
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
