import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { encodeChatStateData } from "../../../packages/database/codec/chatState";
import { validateStorageDatabase } from "../../../packages/database/interact/validation";
import { adoptChatState, createChatState } from "../../../packages/libs/chatState";
import { invalidInput } from "../../../packages/libs/inputValidation";
import type { ChatState } from "../../../packages/types/chatState";
import type { StorageDatabase } from "../../../packages/types/storageDatabase";
import type { TranslateState } from "../../../packages/types/translate";

export interface TranslateSessionMigrationCounts {
  /** 写入翻译会话的群数。 */
  readonly migratedChats: number;
  /** 写入的会话总数。 */
  readonly migratedSessions: number;
  /** 其中原本没有 chat_states 行、为会话新建的群数。 */
  readonly createdChatRows: number;
}

/**
 * 把按群翻译会话写进 chat_states。源库必须是当前 schema、受支持谱系，且任何群状态都
 * 还没有 translate 字段；已有行只替换 status，ai_context 与 ai_persona 原样保留；没有
 * 行的群新建只含会话的 status，总群数不得超过 STATE_MANAGED_CHAT_LIMIT。全部写入
 * 在同一事务内完成，提交后按启动口径复验整库。
 */
export function migrateTranslateSessionsDatabase(
  database: StorageDatabase,
  path: string,
  sessions: ReadonlyMap<number, readonly TranslateState[]>
): TranslateSessionMigrationCounts {
  const chatStates: ReadonlyMap<number, ChatState> = validateStorageDatabase(database, path).hydration.chatStates;
  for (const [chatId, state] of chatStates) {
    if (state.translate !== undefined) {
      return invalidInput(path, `chat_states[${chatId}].status.translate`, "absent before this migration");
    }
  }
  let createdChatRows: number = 0;
  for (const chatId of sessions.keys()) if (!chatStates.has(chatId)) createdChatRows++;
  if (chatStates.size + createdChatRows > STATE_MANAGED_CHAT_LIMIT) {
    return invalidInput(path, "chat_states", `at most ${STATE_MANAGED_CHAT_LIMIT} chats including migrated translation sessions`);
  }
  let migratedSessions: number = 0;
  database.$client.transaction((): void => {
    for (const [chatId, translate] of sessions) {
      const existing: ChatState | undefined = chatStates.get(chatId);
      const state: ChatState = existing === undefined ? createChatState() : adoptChatState(existing);
      state.translate = translate;
      const status: string = encodeChatStateData(state, `chat_states[${chatId}].status`);
      if (existing === undefined) {
        database.$client.run("INSERT INTO chat_states (chat_id, status) VALUES (?, jsonb(?))", [chatId, status]);
      } else {
        database.$client.run("UPDATE chat_states SET status = jsonb(?) WHERE chat_id = ?", [status, chatId]);
      }
      migratedSessions += translate.length;
    }
  })();
  const migrated: ReadonlyMap<number, ChatState> = validateStorageDatabase(database, path).hydration.chatStates;
  for (const [chatId, translate] of sessions) {
    if (JSON.stringify(migrated.get(chatId)?.translate) !== JSON.stringify(translate)) {
      return invalidInput(path, `chat_states[${chatId}].status.translate`, "the migrated translation sessions");
    }
  }
  return { migratedChats: sessions.size, migratedSessions, createdChatRows };
}
