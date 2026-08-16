import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { jsonbText, jsonDataCheck } from "./jsonb";
import type { JsonDataTable } from "./jsonb";
import type { CheckBuilder } from "drizzle-orm/sqlite-core";

/** 白名单：Telegram 用户或频道 ID 为主键，data 保存严格 SQLite JSONB。 */
// Drizzle 需要保留列 builder 的字面量泛型；显式宽化会让查询结果丢失列类型。
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
