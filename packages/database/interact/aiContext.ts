import { isNotNull } from "drizzle-orm";
import { chatStates } from "../schema/chatState";
import { jsonbTextProjection } from "../schema/jsonb";
import { assertTelegramChatId } from "../codec/chatState";
import { decodeAiMemorySnapshot } from "../../libs/persistedSnapshotCodec";
import { parseJsonInput } from "../../libs/inputValidation";
import type { StorageDatabase } from "../../types/storageDatabase";
import type { AiMemorySnapshot } from "../../types/aiChat/memory";

/** 同一启动只读连接严格恢复 JSONB 上下文；SQL NULL 表示从未保存或已清除。 */
export function readStoredAiContexts(database: StorageDatabase, source: string): ReadonlyMap<number, string> {
  const snapshots: Map<number, string> = new Map();
  const rows: readonly Readonly<{ chatId: number; context: string }>[] = database
    .select({ chatId: chatStates.chatId, context: jsonbTextProjection(chatStates.aiContext) })
    .from(chatStates).where(isNotNull(chatStates.aiContext)).all();
  for (const row of rows) {
    const path: string = `${source}:chat_states[${row.chatId}].ai_context`;
    assertTelegramChatId(row.chatId, path);
    const snapshot: AiMemorySnapshot = decodeAiMemorySnapshot(parseJsonInput(row.context, path), path);
    snapshots.set(row.chatId, JSON.stringify(snapshot));
  }
  return snapshots;
}
