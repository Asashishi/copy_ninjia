import { isNotNull } from "drizzle-orm";
import { chatStates } from "../schema/chatState";
import { jsonbTextProjection } from "../schema/jsonb";
import { assertTelegramChatId } from "../codec/chatState";
import { parseAiMemorySnapshot } from "../../libs/persistedSnapshotCodec";
import type { StorageDatabase } from "../../types/storageDatabase";
import type { AiMemorySnapshot } from "../../types/aiChat/memory";

/** 一群 AI 上下文列的安全来源路径，不包含行内容。 */
export function aiContextSource(source: string, chatId: number): string {
  return `${source}:chat_states[${chatId}].ai_context`;
}

/** 同一启动只读连接严格恢复 JSONB 上下文；SQL NULL 表示从未保存或已清除。 */
export function readStoredAiContexts(database: StorageDatabase, source: string): ReadonlyMap<number, string> {
  const snapshots: Map<number, string> = new Map();
  const rows: readonly Readonly<{ chatId: number; context: string }>[] = database
    .select({ chatId: chatStates.chatId, context: jsonbTextProjection(chatStates.aiContext) })
    .from(chatStates).where(isNotNull(chatStates.aiContext)).all();
  for (const row of rows) {
    const path: string = aiContextSource(source, row.chatId);
    assertTelegramChatId(row.chatId, path);
    const snapshot: AiMemorySnapshot = parseAiMemorySnapshot(row.context, path);
    snapshots.set(row.chatId, JSON.stringify(snapshot));
  }
  return snapshots;
}
