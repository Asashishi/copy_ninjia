import {
  storagePendingBudgets,
  pendingChatQaEntryCount,
  pendingChatQaWrites,
} from "../../../cache/workers/diskIO/storageDatabase";
import { storageWriteCost } from "../../../libs/storageWriteBudget";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { CHAT_QA_MAX_PER_CHAT } from "../../../consts/qa";
import { assertChatQaQuestion, decodeChatQaData } from "../../../database/codec/chatQa";
import { assertTelegramChatId } from "../../../database/codec/chatState";
import { readStoredChatQaQuestions } from "../../../database/interact/chatQa";
import type {
  ChatQaWriteDiskMessage,
} from "../../../types/diskIO/messages";
import type {
  IdentityPersistenceReply,
} from "../../../types/diskIO/replies";
import type { PendingChatQaWrite } from "../../../types/identityStorage";
import type { StoredChatQaRow } from "../../../types/storageDatabase";
import { assertPositiveRevision, requireStorageDatabase, storageSource } from "./context";
import { flushIfStorageFull } from "./flush";

/**
 * 某群已提交问题叠加未提交最终值后的有效问题集合。
 *
 * 只查这一个群的 `q` 列，不读 data（JSONB BLOB）。口径同 chat_states 的容量闸。
 */
function effectiveChatQaQuestions(chatId: number): Set<string> {
  const rows: readonly Pick<StoredChatQaRow, "q">[] = readStoredChatQaQuestions(
    requireStorageDatabase(),
    chatId
  );
  const questions: Set<string> = new Set<string>();
  for (const row of rows) questions.add(row.q);
  const pending: Map<string, PendingChatQaWrite> | undefined =
    pendingChatQaWrites.get(chatId);
  if (pending !== undefined) {
    for (const [q, write] of pending) {
      if (write.data === null) questions.delete(q);
      else questions.add(q);
    }
  }
  return questions;
}

/** 收下一条问答最终值；每群条数上限在进入事务缓冲前严格验证。 */
export function handleChatQaWrite(
  message: ChatQaWriteDiskMessage,
  reply: IdentityPersistenceReply
): void {
  const rowSource: string = storageSource("chat_qa", message.chatId);
  assertTelegramChatId(message.chatId, rowSource);
  assertChatQaQuestion(message.q, rowSource);
  assertPositiveRevision(message.revision, rowSource);
  // 解码只为在进缓冲前拒掉非法答案，结果不留用；落库的是主线程已编码的文本。
  if (message.data !== null) decodeChatQaData(message.data, rowSource);

  const questions: Map<string, PendingChatQaWrite> =
    pendingChatQaWrites.get(message.chatId) ?? new Map<string, PendingChatQaWrite>();
  const current: PendingChatQaWrite | undefined = questions.get(message.q);
  // 迟到的写不得覆盖更新的最终值；与其它领域同一条 revision 单调规则。
  if (current !== undefined && current.revision >= message.revision) return;

  const effective: Set<string> = effectiveChatQaQuestions(message.chatId);
  if (message.data === null) effective.delete(message.q);
  else effective.add(message.q);
  if (effective.size > CHAT_QA_MAX_PER_CHAT) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}:chat_qa must contain at most ` +
      `${CHAT_QA_MAX_PER_CHAT} entries per chat; remove one before adding another.`
    );
  }

  storagePendingBudgets.chatQa.reserve(current === undefined ? 1 : 0, storageWriteCost(message.data, message.q) - (current === undefined ? 0 : storageWriteCost(current.data, message.q)));
  questions.set(message.q, { data: message.data, revision: message.revision });
  if (current === undefined) pendingChatQaEntryCount.current++;
  pendingChatQaWrites.set(message.chatId, questions);
  flushIfStorageFull(reply);
}
