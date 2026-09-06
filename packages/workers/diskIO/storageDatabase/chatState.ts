import { storagePendingBudget } from "../../../cache/workers/diskIO/storageDatabase";
import { storageWriteCost } from "../../../libs/storageWriteBudget";
import { pendingChatStateWrites } from
  "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../consts/storage";
import {
  assertTelegramChatId,
  decodeChatStateData,
} from "../../../database/codec/chatState";
import {
  readStoredChatStateIds,
  readStoredChatStates,
} from "../../../database/interact/chatState";
import type {
  ChatStateWriteDiskMessage,
} from "../../../types/diskIO/messages";
import type {
  IdentityPersistenceReply,
} from "../../../types/diskIO/replies";
import type { ChatState } from "../../../types/chatState";
import type { PendingChatStateWrite } from "../../../types/identityStorage";
import type { StoredChatStateRow } from "../../../types/storageDatabase";
import { requireStorageDatabase, storageSource } from "./context";
import { flushIfStorageFull } from "./flush";

/** 已提交主键叠加未提交最终值后的有效群集合；容量闸只需要这个，不碰 data。 */
function effectiveChatStateIds(): Set<number> {
  const rows: readonly Pick<StoredChatStateRow, "chatId">[] =
    readStoredChatStateIds(requireStorageDatabase());
  const chatIds: Set<number> = new Set();
  for (const row of rows) chatIds.add(row.chatId);
  for (const [chatId, pending] of pendingChatStateWrites) {
    if (pending.data === null) chatIds.delete(chatId);
    else chatIds.add(chatId);
  }
  return chatIds;
}

/** 同上但带 data，供唯一代理目标核对；只有「本次写打开了代理」那一条会走到。 */
function effectiveChatStateData(): Map<number, string> {
  const rows: readonly StoredChatStateRow[] = readStoredChatStates(requireStorageDatabase());
  const values: Map<number, string> = new Map();
  for (const row of rows) values.set(row.chatId, row.data);
  for (const [chatId, pending] of pendingChatStateWrites) {
    if (pending.data === null) values.delete(chatId);
    else values.set(chatId, pending.data);
  }
  return values;
}

/** 收下一群最终状态；容量和唯一代理目标在进入事务缓冲前严格验证。 */
export function handleChatStateWrite(
  message: ChatStateWriteDiskMessage,
  reply: IdentityPersistenceReply
): void {
  const rowSource: string = storageSource("chat_states", message.chatId);
  assertTelegramChatId(message.chatId, rowSource);
  if (!Number.isSafeInteger(message.revision) || message.revision < 1) {
    throw new Error(`${rowSource}: revision must be a positive safe integer.`);
  }
  // 解码结果留着用：下面的唯一代理目标判定只关心「这次写有没有把 isProxySendEnabled
  // 打开」，重新解一遍纯属白付一次完整校验。
  const incoming: ChatState | null = message.data === null
    ? null
    : decodeChatStateData(message.data, rowSource);
  const current: PendingChatStateWrite | undefined = pendingChatStateWrites.get(
    message.chatId
  );
  if (current !== undefined && current.revision >= message.revision) return;

  const effective: Set<number> = effectiveChatStateIds();
  if (message.data === null) effective.delete(message.chatId);
  else effective.add(message.chatId);
  if (effective.size > STATE_MANAGED_CHAT_LIMIT) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}:chat_states must contain at most ` +
      `${STATE_MANAGED_CHAT_LIMIT} chats; delete chats that are no longer managed before adding another chat.`
    );
  }
  // 唯一代理目标是归纳不变量：启动整表恢复先验证已有行，此后每次写入都过此闸。
  // 只有把 isProxySendEnabled 打开的写入可能破坏它，因此其它字段的更新不扫描整表。
  if (incoming?.isProxySendEnabled === true) {
    for (const [chatId, data] of effectiveChatStateData()) {
      if (chatId === message.chatId) continue;
      if (
        decodeChatStateData(data, storageSource("chat_states", chatId))
          .isProxySendEnabled === true
      ) {
        throw new Error(
          `${IDENTITY_DATABASE_PATH}:chat_states must contain at most one active proxy send target.`
        );
      }
    }
  }
  storagePendingBudget.reserve(current === undefined ? 1 : 0, storageWriteCost(message.data) - (current === undefined ? 0 : storageWriteCost(current.data)));
  pendingChatStateWrites.set(message.chatId, {
    data: message.data,
    revision: message.revision,
  });
  flushIfStorageFull(reply);
}
