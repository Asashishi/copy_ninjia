import { check, integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { CheckBuilder, SQLiteColumn } from "drizzle-orm/sqlite-core";

/** Drizzle 表级约束回调使用的临时白名单列集合。 */
interface TemporaryWhitelistTableParams {
  readonly id: SQLiteColumn;
  readonly tempWhite: SQLiteColumn;
  readonly tempWhiteAt: SQLiteColumn;
  readonly tempWhiteCount: SQLiteColumn;
  readonly sendCount: SQLiteColumn;
  readonly countedAt: SQLiteColumn;
  readonly qualifiedAt: SQLiteColumn;
}

/** 临时白名单及连续日累计；全部字段使用关系列，不把可查询状态收进 JSON。 */
// Drizzle 需要保留列 builder 的字面量泛型；显式宽化会让查询结果丢失列类型。
// eslint-disable-next-line @typescript-eslint/typedef
export const temporaryWhitelistEntries = sqliteTable("temporary_whitelist_entries", {
  id: integer("id", { mode: "number" }).primaryKey(),
  tempWhite: integer("temp_white", { mode: "boolean" }).notNull(),
  tempWhiteAt: integer("temp_white_at", { mode: "number" }),
  tempWhiteCount: integer("temp_white_count", { mode: "number" }).notNull(),
  sendCount: integer("send_count", { mode: "number" }).notNull(),
  countedAt: integer("counted_at", { mode: "number" }).notNull(),
  qualifiedAt: integer("qualified_at", { mode: "number" }),
}, (table: TemporaryWhitelistTableParams): CheckBuilder[] => [
  check("temporary_whitelist_id", sql`${table.id} <> 0`),
  check("temporary_whitelist_flag", sql`${table.tempWhite} IN (0, 1)`),
  check(
    "temporary_whitelist_timestamp",
    sql`(${table.tempWhite} = 1 AND ${table.tempWhiteAt} IS NOT NULL) OR (${table.tempWhite} = 0 AND ${table.tempWhiteAt} IS NULL)`
  ),
  check(
    "temporary_whitelist_day_count",
    sql`${table.tempWhiteCount} BETWEEN 0 AND 7 AND (${table.tempWhite} = 1 OR ${table.tempWhiteCount} = 0)`
  ),
  check("temporary_whitelist_send_count", sql`${table.sendCount} >= 1`),
  check("temporary_whitelist_counted_at", sql`${table.countedAt} >= 0`),
  check(
    "temporary_whitelist_qualified_at",
    sql`(${table.qualifiedAt} IS NULL AND ${table.sendCount} <= 7) OR (${table.qualifiedAt} BETWEEN 0 AND ${table.countedAt} AND ${table.sendCount} > 7 AND ${table.tempWhiteCount} >= 1)`
  ),
  check(
    "temporary_whitelist_granted_at",
    sql`${table.tempWhiteAt} IS NULL OR (${table.tempWhiteAt} BETWEEN 0 AND ${table.countedAt} AND (${table.qualifiedAt} IS NULL OR ${table.tempWhiteAt} <= ${table.qualifiedAt}))`
  ),
]);
