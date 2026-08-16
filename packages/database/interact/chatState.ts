import { chatStates } from "../schema/chatState";
import { jsonbTextProjection } from "../schema/jsonb";
import type {
  StorageDatabase,
  StoredChatStateRow,
} from "../../types/storageDatabase";

/**
 * 只读取已提交群状态的主键。
 *
 * 容量闸要的只是「现在有哪些群」，而 data 是 JSONB BLOB，读它必须逐行经
 * `jsonbTextProjection` 物化成 JSON 文本（见 database/schema/jsonb.ts）——那是每次
 * 群状态写入都要为最多 STATE_MANAGED_CHAT_LIMIT 行白付的转换与字符串分配。
 * 判定仍然每次现算，不引入任何需要跨写入维护的 Worker 侧状态。
 */
export function readStoredChatStateIds(
  database: StorageDatabase
): readonly Pick<StoredChatStateRow, "chatId">[] {
  return database.select({ chatId: chatStates.chatId }).from(chatStates).all();
}

/** 读取已提交群状态行（含 data）；启动整表恢复与唯一代理目标核对时使用。 */
export function readStoredChatStates(
  database: StorageDatabase
): readonly StoredChatStateRow[] {
  return database
    .select({ chatId: chatStates.chatId, data: jsonbTextProjection(chatStates.data) })
    .from(chatStates)
    .all();
}
