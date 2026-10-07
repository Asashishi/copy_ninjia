import { chatStates } from "../schema/chatState";
import { jsonbTextProjection } from "../schema/jsonb";
import type {
  StorageDatabase,
  StoredChatStateRow,
} from "../../types/storageDatabase";

/**
 * 只读取已提交群状态的主键，不读取 data 列（JSONB BLOB，需经
 * `jsonbTextProjection` 物化成 JSON 文本，见 database/schema/jsonb.ts）。
 * 容量闸按查询结果现算，不维护 Worker 侧状态。
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
    .select({ chatId: chatStates.chatId, data: jsonbTextProjection(chatStates.status) })
    .from(chatStates)
    .all();
}
