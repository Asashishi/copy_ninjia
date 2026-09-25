import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { jsonbText, jsonDataCheck } from "./jsonb";
import type { JsonDataTable } from "./jsonb";
import type { CheckBuilder } from "drizzle-orm/sqlite-core";

/** 权限名单：Telegram 用户或频道 ID 为主键，policy 保存严格 SQLite JSONB。 */
// Drizzle 需要保留列 builder 的字面量泛型；显式宽化会让查询结果丢失列类型。
// eslint-disable-next-line @typescript-eslint/typedef
export const permissionList = sqliteTable("permission_list", {
  id: integer("id", { mode: "number" }).primaryKey(),
  data: jsonbText("policy").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("permission_list_data_jsonb", table));

/** 黑名单：Telegram 用户或频道 ID 为主键，data 保存严格 SQLite JSONB。 */
// eslint-disable-next-line @typescript-eslint/typedef -- 同 permissionList。
export const blocklistEntries = sqliteTable("blocklist_entries", {
  id: integer("id", { mode: "number" }).primaryKey(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("blocklist_entries_data_jsonb", table));
