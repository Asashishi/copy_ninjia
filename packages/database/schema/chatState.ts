import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { jsonbText, jsonDataCheck } from "./jsonb";
import type { JsonDataTable } from "./jsonb";
import type { CheckBuilder } from "drizzle-orm/sqlite-core";

/** 群/频道状态：Telegram chat ID 为主键，data 保存严格 SQLite JSONB。 */
// Drizzle 需要保留列 builder 的字面量泛型；显式宽化会让查询结果丢失列类型。
// eslint-disable-next-line @typescript-eslint/typedef
export const chatStates = sqliteTable("chat_states", {
  chatId: integer("chat_id", { mode: "number" }).primaryKey(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable): CheckBuilder[] =>
  jsonDataCheck("chat_states_data_jsonb", table));
