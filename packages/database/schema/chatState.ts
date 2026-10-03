import { sql } from "drizzle-orm";
import { check, integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { jsonbText } from "./jsonb";
import type { CheckBuilder, SQLiteColumn } from "drizzle-orm/sqlite-core";

interface ChatStateColumns {
  readonly status: SQLiteColumn;
  readonly aiContext: SQLiteColumn;
}

/** 群状态与 AI 上下文使用独立 JSONB 列；上下文只能属于已有群状态。 */
// eslint-disable-next-line @typescript-eslint/typedef
export const chatStates = sqliteTable("chat_states", {
  chatId: integer("chat_id", { mode: "number" }).primaryKey(),
  status: jsonbText("status").notNull(),
  aiContext: jsonbText("ai_context"),
}, (table: ChatStateColumns): CheckBuilder[] => [
  check("chat_states_status_jsonb", sql`typeof(${table.status}) = 'blob' AND json_valid(${table.status}, 8)`),
  check("chat_states_ai_context_jsonb", sql`${table.aiContext} IS NULL OR (typeof(${table.aiContext}) = 'blob' AND json_valid(${table.aiContext}, 8))`),
]);
