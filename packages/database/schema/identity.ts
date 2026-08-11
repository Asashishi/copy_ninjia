import { sql } from "drizzle-orm";
import {
  check,
  customType,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import {
  IDENTITY_DATABASE_JSONB_STRICT_VALIDATION_FLAG,
  IDENTITY_DATABASE_JSONB_VALIDATION_FLAG,
} from "../../consts/identityStorage";
import type { SQL } from "drizzle-orm";
import type { CheckBuilder, SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * SQLite JSONB 的 Drizzle 驱动编解码边界。
 *
 * 写入时由 SQLite 自己把已严格校验的 JSON 文本编码为私有 JSONB BLOB；读取由
 * 下方 schema 表达式转回文本。业务交互层因此只使用 Drizzle query builder，
 * 不接触 SQLite 私有二进制格式。
 */
const jsonbText: ReturnType<typeof customType<{
  data: string;
  driverData: Uint8Array;
}>> = customType<{
  data: string;
  driverData: Uint8Array;
}>({
  dataType: (): string => "blob",
  toDriver: (value: string): SQL => sql`jsonb(${value})`,
  fromDriver: (_value: Uint8Array): never => {
    throw new Error("SQLite JSONB columns must be read through their schema projection.");
  },
});

interface JsonDataTable {
  readonly data: SQLiteColumn;
}

function jsonDataCheck(name: string, table: JsonDataTable): CheckBuilder[] {
  const validationFlag: SQL = sql.raw(String(IDENTITY_DATABASE_JSONB_VALIDATION_FLAG));
  return [check(name, sql`json_valid(${table.data}, ${validationFlag})`)];
}

/** 把 SQLite 私有 JSONB BLOB 投影为可交给严格领域解码器的规范 JSON 文本。 */
export function jsonbTextProjection(column: SQLiteColumn): SQL<string> {
  return sql<string>`json(${column})`;
}

/** 返回 SQLite 实际保存某行 data 的存储类，供启动完整性校验使用。 */
export function jsonbStorageClass(column: SQLiteColumn): SQL<string> {
  return sql<string>`typeof(${column})`;
}

/** 严格校验某行 data 是否为 SQLite JSONB，而非仅外观相似的 BLOB。 */
export function strictJsonbValidity(column: SQLiteColumn): SQL<number> {
  const validationFlag: number = IDENTITY_DATABASE_JSONB_STRICT_VALIDATION_FLAG;
  return sql<number>`json_valid(${column}, ${validationFlag})`;
}

/** 白名单：Telegram 用户或频道 ID 为主键，data 保存严格 SQLite JSONB。 */
// Drizzle 需要从列 builder 保留字面量泛型；显式宽化会让查询结果丢失列类型。
// eslint-disable-next-line @typescript-eslint/typedef
export const whitelistEntries = sqliteTable("whitelist_entries", {
  id: integer("id", { mode: "number" }).primaryKey(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("whitelist_entries_data_jsonb", table));

/** 黑名单：Telegram 用户或频道 ID 为主键，data 保存严格 SQLite JSONB。 */
// eslint-disable-next-line @typescript-eslint/typedef -- 理由同 whitelistEntries。
export const blocklistEntries = sqliteTable("blocklist_entries", {
  id: integer("id", { mode: "number" }).primaryKey(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("blocklist_entries_data_jsonb", table));

/** 待踢成员：进程内 removalId 为主键，data 保存严格 SQLite JSONB。 */
// eslint-disable-next-line @typescript-eslint/typedef -- 理由同 whitelistEntries。
export const pendingBlockedRemovals = sqliteTable("pending_blocked_removals", {
  removalId: integer("removal_id", { mode: "number" }).primaryKey(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("pending_blocked_removals_data_jsonb", table));

/** 数据库自身元数据；当前只记录严格 schema 版本。 */
// eslint-disable-next-line @typescript-eslint/typedef -- 理由同 whitelistEntries。
export const storageMetadata = sqliteTable("storage_metadata", {
  key: text("key").primaryKey(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("storage_metadata_data_jsonb", table));

/** Drizzle 的完整 schema；连接边界必须显式绑定它。 */
export const identityDatabaseSchema: Readonly<{
  whitelistEntries: typeof whitelistEntries;
  blocklistEntries: typeof blocklistEntries;
  pendingBlockedRemovals: typeof pendingBlockedRemovals;
  storageMetadata: typeof storageMetadata;
}> = {
  whitelistEntries,
  blocklistEntries,
  pendingBlockedRemovals,
  storageMetadata,
};
