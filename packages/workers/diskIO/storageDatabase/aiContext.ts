import { pendingChatStateWrites, storagePersistenceReplyHolder } from "../../../cache/workers/diskIO/storageDatabase";
import { flushStorageDatabase } from "./flush";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { eq } from "drizzle-orm";
import { chatStates } from "../../../database/schema/chatState";
import { assertTelegramChatId } from "../../../database/codec/chatState";
import { decodeAiMemorySnapshot } from "../../../libs/persistedSnapshotCodec";
import { parseJsonInput } from "../../../libs/inputValidation";
import { requireStorageDatabase, storageSource } from "./context";

/** 只更新当前群的上下文列；群已删除时不重建行，迟到快照不能复活停管数据。 */
export function writeAiContext(chatId: number, snapshot: string): void {
  const source: string = `${IDENTITY_DATABASE_PATH}:chat_states[${chatId}].ai_context`;
  assertTelegramChatId(chatId, source);
  decodeAiMemorySnapshot(parseJsonInput(snapshot, source), source);
  flushPendingChatState(chatId);
  requireStorageDatabase().update(chatStates).set({ aiContext: snapshot })
    .where(eq(chatStates.chatId, chatId)).run();
}

/** 只清除上下文，群状态与个性化提示词仍由各自生命周期持有。 */
export function deleteAiContext(chatId: number): void {
  assertTelegramChatId(chatId, storageSource("chat_states", chatId));
  flushPendingChatState(chatId);
  requireStorageDatabase().update(chatStates).set({ aiContext: null })
    .where(eq(chatStates.chatId, chatId)).run();
}

/** 先提交同群在途状态，保证首次快照不会早于建行，删除后的快照不会重建状态。 */
function flushPendingChatState(chatId: number): void {
  if (!pendingChatStateWrites.has(chatId)) return;
  const reply: typeof storagePersistenceReplyHolder.current = storagePersistenceReplyHolder.current;
  if (reply === null || !flushStorageDatabase(reply)) throw new Error("Pending chat state must be durable before its AI context.");
}
