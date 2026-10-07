import { eq } from "drizzle-orm";
import { chatQa } from "../schema/chatQa";
import { jsonbTextProjection } from "../schema/jsonb";
import type {
  StorageDatabase,
  StoredChatQaRow,
} from "../../types/storageDatabase";

/** 读取全部已提交问答行（含 data）；启动按 STATE_MANAGED_CHAT_LIMIT 群、每群 CHAT_QA_MAX_PER_CHAT 条的上限恢复。 */
export function readStoredChatQa(
  database: StorageDatabase
): readonly StoredChatQaRow[] {
  return database
    .select({
      chatId: chatQa.chatId,
      q: chatQa.q,
      data: jsonbTextProjection(chatQa.data),
    })
    .from(chatQa)
    .all();
}

/**
 * 只读取某一群已提交问答的问题文本，不读取 data 列（JSONB BLOB，需经
 * `jsonbTextProjection` 物化成 JSON 文本）。容量闸只读取该群已登记的
 * 问题；做法同 readStoredChatStateIds。
 */
export function readStoredChatQaQuestions(
  database: StorageDatabase,
  chatId: number
): readonly Pick<StoredChatQaRow, "q">[] {
  return database
    .select({ q: chatQa.q })
    .from(chatQa)
    .where(eq(chatQa.chatId, chatId))
    .all();
}
