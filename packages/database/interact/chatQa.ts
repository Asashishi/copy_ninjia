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
 * 只读取某一群已提交问答的问题文本。
 *
 * 容量闸要的只是「这个群现在登记了哪几句」，而 data 是 JSONB BLOB，读它必须
 * 逐行经 `jsonbTextProjection` 物化成 JSON 文本——那是每次问答写入都要为该群
 * 已有行白付的转换与字符串分配。与 readStoredChatStateIds 同一取舍。
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
