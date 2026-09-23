import { eq } from "drizzle-orm";
import { chatQa } from "../schema/chatQa";
import { jsonbTextProjection } from "../schema/jsonb";
import type {
  StorageDatabase,
  StoredChatQaRow,
} from "../../types/storageDatabase";

/** 读取全部已提交问答行（含 data）；启动按 25 群、每群 15 条的硬顶恢复。 */
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
 * `jsonbTextProjection` 物化成 JSON 文本）。容量闸只需要知道该群已登记哪些
 * 问题；做法与 readStoredChatStateIds 相同。
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
