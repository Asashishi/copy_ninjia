/**
 * 身份 SQLite 的唯一交互边界。
 *
 * 连接、Drizzle migration、查询和显式事务都收口在本目录；运行期句柄仍只能由
 * Disk I/O Worker 持有，业务层和迁移脚本只调用这里导出的领域操作。
 */

import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { count, eq, inArray, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  IDENTITY_DATABASE_MIGRATIONS_DIR,
  IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
} from "../../consts/identityStorage";
import {
  blocklistEntries,
  identityDatabaseSchema,
  jsonbStorageClass,
  jsonbTextProjection,
  pendingBlockedRemovals,
  storageMetadata,
  strictJsonbValidity,
  whitelistEntries,
} from "../schema/identity";
import type { IdentityPolicyTable } from "../../types/identityPolicy";
import type {
  IdentityDatabase,
  IdentityDatabaseChange,
  IdentityDatabaseIntegrityRow,
  IdentityDatabaseJsonStorageRow,
  IdentityDatabaseMigrationJournalEntry,
  IdentityDatabaseRows,
  StoredIdentityMetadataRow,
  StoredIdentityIdRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
} from "../../types/identityDatabase";
import type { AnySQLiteColumn, AnySQLiteTable } from "drizzle-orm/sqlite-core";

type IdentityDatabaseTransaction = Parameters<
  Parameters<IdentityDatabase["transaction"]>[0]
>[0];

export interface OpenIdentityDatabaseOptions {
  readonly path: string;
  readonly readonly?: boolean;
  readonly requireWritableAccess?: boolean;
}

/** 打开既有数据库；生产 owner 可同时要求文件和父目录具备写权限。 */
export function openIdentityDatabase({
  path,
  readonly: isReadonly = false,
  requireWritableAccess = false,
}: OpenIdentityDatabaseOptions): IdentityDatabase {
  if (!existsSync(path)) {
    throw new Error(`${path}: database file is missing; run the identity storage migration first.`);
  }
  if (requireWritableAccess) {
    accessSync(path, constants.R_OK | constants.W_OK);
    accessSync(dirname(path), constants.R_OK | constants.W_OK | constants.X_OK);
  }
  const client: Database = new Database(path, {
    create: false,
    ...(isReadonly ? { readonly: true } : { readwrite: true }),
    strict: true,
    safeIntegers: false,
  });
  return drizzle({ client, schema: identityDatabaseSchema });
}

/** 关闭身份数据库连接；由持有句柄的调用边界显式触发。 */
export function closeIdentityDatabase(database: IdentityDatabase): void {
  database.$client.close(false);
}

/** 创建新库并交给 Drizzle 内建 migrator 建表；已存在时拒绝覆盖。 */
export function createIdentityDatabase(path: string): void {
  if (existsSync(path)) {
    throw new Error(`${path}: target already exists; refusing to overwrite it.`);
  }
  const client: Database = new Database(path, {
    create: true,
    readwrite: true,
    strict: true,
    safeIntegers: false,
  });
  try {
    const database: IdentityDatabase = drizzle({ client, schema: identityDatabaseSchema });
    migrateIdentityDatabaseSchema(database);
  } finally {
    client.close(false);
  }
}

/**
 * 对已由部署流程完成外部备份的身份库显式执行 schema migrations。
 * 生产启动路径不得调用；旧版本必须先停服务并手工迁移，再进入严格 hydrate。
 */
export function migrateIdentityDatabaseSchema(database: IdentityDatabase): void {
  migrate(database, { migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
}

/** 读取并严格校验 Drizzle 身份库迁移谱系；部署脚本据此拒绝未知历史。 */
export function readIdentityDatabaseMigrationJournal(
  database: IdentityDatabase
): readonly IdentityDatabaseMigrationJournalEntry[] {
  const rows: IdentityDatabaseMigrationJournalEntry[] = database.$client
    .query<IdentityDatabaseMigrationJournalEntry, []>(
      "SELECT created_at AS createdAt, hash " +
      "FROM __drizzle_migrations ORDER BY created_at ASC;"
    )
    .all();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.createdAt) ||
      row.createdAt < 1 ||
      !/^[a-f0-9]{64}$/.test(row.hash)
    ) {
      throw new Error("Identity database contains an invalid Drizzle migration journal entry.");
    }
  }
  return rows;
}

/** 生成包含当前 WAL 可见状态的一致 SQLite 字节快照，供工作树外迁移备份使用。 */
export function serializeIdentityDatabaseSnapshot(
  database: IdentityDatabase
): Uint8Array {
  return database.$client.serialize();
}

/** 按 Bun 官方建议为已发布的新库启用 WAL。 */
export function enableIdentityDatabaseWal(path: string): void {
  const database: IdentityDatabase = openIdentityDatabase({ path });
  try {
    database.$client.run("PRAGMA journal_mode = WAL;");
  } finally {
    closeIdentityDatabase(database);
  }
}

/** 执行 SQLite 原生完整性检查；Drizzle 不提供 PRAGMA DSL，因此只在本交互边界调用。 */
export function assertIdentityDatabaseIntegrity(database: IdentityDatabase): void {
  const rows: IdentityDatabaseIntegrityRow[] = database.$client
    .query<IdentityDatabaseIntegrityRow, []>("PRAGMA integrity_check;")
    .all();
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error("Identity database failed SQLite integrity_check.");
  }
}

interface ReadJsonbStorageRowOptions {
  readonly tableName: string;
  readonly table: AnySQLiteTable;
  readonly data: AnySQLiteColumn;
}

function readJsonbStorageRow(
  database: IdentityDatabase,
  { tableName, table, data }: ReadJsonbStorageRowOptions
): IdentityDatabaseJsonStorageRow {
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

/** 读取四张表的 Drizzle 声明及实际存储类型；部署迁移和启动前校验共用。 */
export function readIdentityDatabaseJsonStorage(
  database: IdentityDatabase
): readonly IdentityDatabaseJsonStorageRow[] {
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

/** 拒绝列声明、存储类型或内容不是严格 JSONB 的身份数据库。 */
export function assertIdentityDatabaseJsonbStorage(
  database: IdentityDatabase,
  source: string
): void {
  const rows: readonly IdentityDatabaseJsonStorageRow[] =
    readIdentityDatabaseJsonStorage(database);
  if (rows.length !== 4) {
    throw new Error(`${source}: expected JSONB storage metadata for exactly four identity tables.`);
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

/** 读取四张领域表的原始行；严格业务解码由调用层按来源路径完成。 */
export function readIdentityDatabaseRows(
  database: IdentityDatabase
): IdentityDatabaseRows {
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
  const metadata: StoredIdentityMetadataRow[] = database
    .select({ key: storageMetadata.key, data: jsonbTextProjection(storageMetadata.data) })
    .from(storageMetadata)
    .all();
  return { whitelist, blocklist, removals, metadata };
}

/** 查询某名单主键是否已经持久化；使用 Drizzle get 避免构造单元素数组。 */
export function hasStoredIdentityPolicy(
  database: IdentityDatabase,
  table: IdentityPolicyTable,
  id: number
): boolean {
  const row: StoredIdentityIdRow | undefined = table === "whitelist"
    ? database.select({ id: whitelistEntries.id }).from(whitelistEntries)
      .where(eq(whitelistEntries.id, id)).get()
    : database.select({ id: blocklistEntries.id }).from(blocklistEntries)
      .where(eq(blocklistEntries.id, id)).get();
  return row !== undefined;
}

/** 读取已提交黑名单主键，供 Worker 叠加其事务缓冲。 */
export function readStoredBlocklistIds(database: IdentityDatabase): readonly number[] {
  const rows: StoredIdentityIdRow[] = database
    .select({ id: blocklistEntries.id })
    .from(blocklistEntries)
    .all();
  return rows.map((row: StoredIdentityIdRow): number => row.id);
}

/** 批量读取某名单的已提交行；JSONB 解码统一经过 schema 文本投影。 */
export function readStoredIdentityPolicies(
  database: IdentityDatabase,
  table: IdentityPolicyTable,
  ids: readonly number[]
): readonly StoredIdentityPolicyRow[] {
  if (ids.length === 0) return [];
  if (ids.length > IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES) {
    throw new Error(
      `Identity policy reads accept at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs.`
    );
  }
  return table === "whitelist"
    ? database
      .select({ id: whitelistEntries.id, data: jsonbTextProjection(whitelistEntries.data) })
      .from(whitelistEntries)
      .where(inArray(whitelistEntries.id, ids))
      .all()
    : database
      .select({ id: blocklistEntries.id, data: jsonbTextProjection(blocklistEntries.data) })
      .from(blocklistEntries)
      .where(inArray(blocklistEntries.id, ids))
      .all();
}

export interface CommitIdentityDatabaseChangesOptions {
  readonly whitelist: ReadonlyMap<number, IdentityDatabaseChange>;
  readonly blocklist: ReadonlyMap<number, IdentityDatabaseChange>;
  readonly removals: ReadonlyMap<number, IdentityDatabaseChange>;
}

/** 三张业务表的最终值在一个 Drizzle 显式事务中提交。 */
export function commitIdentityDatabaseChanges(
  database: IdentityDatabase,
  { whitelist, blocklist, removals }: CommitIdentityDatabaseChangesOptions
): void {
  database.transaction((transaction: IdentityDatabaseTransaction): void => {
    for (const [id, change] of whitelist) {
      if (change.data === null) {
        transaction.delete(whitelistEntries).where(eq(whitelistEntries.id, id)).run();
      } else {
        transaction.insert(whitelistEntries).values({ id, data: change.data })
          .onConflictDoUpdate({ target: whitelistEntries.id, set: { data: change.data } })
          .run();
      }
    }
    for (const [id, change] of blocklist) {
      if (change.data === null) {
        transaction.delete(blocklistEntries).where(eq(blocklistEntries.id, id)).run();
      } else {
        transaction.insert(blocklistEntries).values({ id, data: change.data })
          .onConflictDoUpdate({ target: blocklistEntries.id, set: { data: change.data } })
          .run();
      }
    }
    for (const [removalId, change] of removals) {
      if (change.data === null) {
        transaction.delete(pendingBlockedRemovals)
          .where(eq(pendingBlockedRemovals.removalId, removalId)).run();
      } else {
        transaction.insert(pendingBlockedRemovals)
          .values({ removalId, data: change.data })
          .onConflictDoUpdate({
            target: pendingBlockedRemovals.removalId,
            set: { data: change.data },
          }).run();
      }
    }
  });
}

export interface SeedIdentityDatabaseOptions {
  readonly metadata: readonly StoredIdentityMetadataRow[];
  readonly whitelist: readonly StoredIdentityPolicyRow[];
  readonly blocklist: readonly StoredIdentityPolicyRow[];
  readonly removals: readonly StoredPendingRemovalRow[];
}

/** 一次性迁移在一个 Drizzle 事务内写入 JSONB schema 版本和全部业务行。 */
export function seedIdentityDatabase(
  database: IdentityDatabase,
  { metadata, whitelist, blocklist, removals }: SeedIdentityDatabaseOptions
): void {
  database.transaction((transaction: IdentityDatabaseTransaction): void => {
    if (metadata.length > 0) transaction.insert(storageMetadata).values([...metadata]).run();
    if (whitelist.length > 0) transaction.insert(whitelistEntries).values([...whitelist]).run();
    if (blocklist.length > 0) transaction.insert(blocklistEntries).values([...blocklist]).run();
    if (removals.length > 0) transaction.insert(pendingBlockedRemovals).values([...removals]).run();
  });
}

/** 清空三张业务表；测试隔离复用同一空 schema 时使用。 */
export function clearIdentityBusinessTables(database: IdentityDatabase): void {
  database.transaction((transaction: IdentityDatabaseTransaction): void => {
    transaction.delete(pendingBlockedRemovals).run();
    transaction.delete(whitelistEntries).run();
    transaction.delete(blocklistEntries).run();
  });
}

export interface PutIdentityPolicyRowOptions {
  readonly database: IdentityDatabase;
  readonly table: IdentityPolicyTable;
  readonly id: number;
  readonly data: string;
}

/** 写入一条原始名单行；迁移逐值校验和损坏数据回归测试使用。 */
export function putIdentityPolicyRow({
  database,
  table,
  id,
  data,
}: PutIdentityPolicyRowOptions): void {
  if (table === "whitelist") {
    database.insert(whitelistEntries).values({ id, data })
      .onConflictDoUpdate({ target: whitelistEntries.id, set: { data } }).run();
    return;
  }
  database.insert(blocklistEntries).values({ id, data })
    .onConflictDoUpdate({ target: blocklistEntries.id, set: { data } }).run();
}
