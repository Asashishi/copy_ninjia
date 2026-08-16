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
  IdentityPersistenceReply,
} from "../../../types/diskIO";
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
  // 唯一代理目标是**归纳**不变量：写这一条之前它已经成立——每次写入都过这道闸，
  // 而库里已有的行由本 Worker 自己的启动整表恢复把关（见
  // database/validation/storageRows.ts，它不依赖主线程准入）。因此只有「把
  // isProxySendEnabled 打开」的这一条写才可能破坏它，别的写一律不必看其它行。
  //
  // 原先无论写什么都要把整张表（最多 STATE_MANAGED_CHAT_LIMIT 行）逐行 JSON.parse
  // 再跑完整字段/lockdown/18 位权限校验，只为数一个布尔。25 群启动时
  // refreshAllChatTitles 每群一次后台写，那一阵就是 625 次完整解码，且正好落在
  // runner 开始灌 update 的窗口里。改完之后真正会走进下面这个循环的只有
  // /send 开会话那一次。
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
  pendingChatStateWrites.set(message.chatId, {
    data: message.data,
    revision: message.revision,
  });
  flushIfStorageFull(reply);
}
