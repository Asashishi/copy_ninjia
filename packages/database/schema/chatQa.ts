import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonbText, jsonDataCheck } from "./jsonb";
import type { JsonDataTable } from "./jsonb";
import type {
  CheckBuilder,
  SQLiteColumn,
  SQLiteTableExtraConfigValue,
} from "drizzle-orm/sqlite-core";

/**
 * 群问答：`(chat_id, q)` 复合主键，`data` 保存严格 SQLite JSONB 的 `{"a": …}`。
 * 同一群内一个问题只能有一条答案，由复合主键约束唯一性。
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
