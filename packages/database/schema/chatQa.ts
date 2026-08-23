import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonbText, jsonDataCheck } from "./jsonb";
import type { JsonDataTable } from "./jsonb";
import type { CheckBuilder } from "drizzle-orm/sqlite-core";
import type { SQLiteColumn, SQLiteTableExtraConfigValue } from "drizzle-orm/sqlite-core";

/**
 * 群问答：`(chat_id, q)` 复合主键，`data` 保存严格 SQLite JSONB 的 `{"a": …}`。
 *
 * 问题文本进主键而不是另起自增 id：一个群里同一句问题只能有一个答案，让 SQLite
 * 直接表达这条唯一性，就不必在写入侧再查一次重复。答案放 JSONB 而不是裸 TEXT
 * 列，与本库其它业务表同一口径——表级 CHECK 因此能一并盖住它。
 */
// Drizzle 需要保留列 builder 的字面量泛型；显式宽化会让查询结果丢失列类型。
// eslint-disable-next-line @typescript-eslint/typedef
export const chatQa = sqliteTable("chat_qa", {
  chatId: integer("chat_id", { mode: "number" }).notNull(),
  q: text("q").notNull(),
  data: jsonbText("data").notNull(),
}, (table: JsonDataTable & {
  readonly chatId: SQLiteColumn;
  readonly q: SQLiteColumn;
}): SQLiteTableExtraConfigValue[] => {
  const checks: CheckBuilder[] = jsonDataCheck("chat_qa_data_jsonb", table);
  return [primaryKey({ columns: [table.chatId, table.q] }), ...checks];
});
