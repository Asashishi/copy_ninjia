/**
 * 主线程群问答持久化边界：内存 Map 是唯一热读副本，SQLite 是权威落盘源。
 *
 * 写入在容量准入后发布内存最终值，再只保留 revision，正文不复制到第二张主线程表；
 * Disk I/O Worker 崩溃后从内存重编码并重放未 ACK 的 revision。语义与
 * infra/chatStateStorage.ts 一致，只是主键换成 (chatId, q) 复合键。
 */

import { assertStorageAdmission } from "./diskIO/storageAdmission";
import { canQueueDiskIOBusiness } from "./diskIO/transport";
import { postWithTransport } from "./diskIO/businessWrite";
import { storageWriteCost } from "../libs/storageWriteBudget";
import {
  chatQaEntries,
  nextChatQaRevision,
  unacknowledgedChatQaTotals,
  unacknowledgedChatQaWrites,
} from "../cache/main/qa";
import { CHAT_QA_MAX_PER_CHAT } from "../consts/qa";
import { DISK_IO_RESPAWN_PRIORITIES } from "../consts/diskIO/common";
import { IDENTITY_DATABASE_PATH } from "../consts/paths";
import { encodeChatQaData } from "../database/codec/chatQa";
import * as diskIO from "./diskIO";
import { logger } from "./logger";
import type {
  ChatQaWriteDiskMessage,
  DiskIORecoveryTransport,
} from "../types/diskIO/messages";
import type {
  IdentityStoragePersistedReply,
} from "../types/diskIO/replies";
import type { UnacknowledgedChatQaWrite } from "../types/qa";

/** 问答条数达到上限；命令回执只把这一类失败解释为业务容量已满。 */
export class ChatQaCapacityError extends Error {}

/** 启动恢复把 SQLite 持久化值载入内存。 */
export function hydrateChatQaCache(
  entries: ReadonlyMap<number, ReadonlyMap<string, string>>
): void {
  chatQaEntries.clear();
  unacknowledgedChatQaWrites.clear();
  unacknowledgedChatQaTotals.entries = 0;
  unacknowledgedChatQaTotals.bytes = 0;
  for (const [chatId, questions] of entries) {
    if (questions.size === 0) continue;
    chatQaEntries.set(chatId, new Map(questions));
  }
}

/** 登记一条未 ACK 写入并按差额更新总条数与字节。 */
function trackUnacknowledged(message: ChatQaWriteDiskMessage): void {
  const existing: Map<string, UnacknowledgedChatQaWrite> | undefined =
    unacknowledgedChatQaWrites.get(message.chatId);
  const questions: Map<string, UnacknowledgedChatQaWrite> = existing ?? new Map<string, UnacknowledgedChatQaWrite>();
  if (existing === undefined) unacknowledgedChatQaWrites.set(message.chatId, questions);
  const previous: UnacknowledgedChatQaWrite | undefined = questions.get(message.q);
  const bytes: number = storageWriteCost(message.data, message.q);
  questions.set(message.q, { revision: message.revision, bytes });
  if (previous === undefined) unacknowledgedChatQaTotals.entries++;
  unacknowledgedChatQaTotals.bytes += bytes - (previous?.bytes ?? 0);
}

/** 发布前按差额核对未 ACK 的问题、墓碑和正文预算。 */
function prepareChatQaWrite(chatId: number, q: string, answer: string | undefined): ChatQaWriteDiskMessage {
  const revision: number = nextChatQaRevision.current + 1;
  if (!Number.isSafeInteger(revision)) throw new Error("Chat-qa revision space is exhausted.");
  const data: string | null = answer === undefined ? null : encodeChatQaData(answer, `${IDENTITY_DATABASE_PATH}:chat_qa[${chatId}]`);
  const previous: UnacknowledgedChatQaWrite | undefined = unacknowledgedChatQaWrites.get(chatId)?.get(q);
  assertStorageAdmission(
    unacknowledgedChatQaTotals.entries + (previous === undefined ? 1 : 0),
    unacknowledgedChatQaTotals.bytes + storageWriteCost(data, q) - (previous?.bytes ?? 0)
  );
  const message: ChatQaWriteDiskMessage = { type: "chatQaWrite", chatId, q, data, revision };
  if (!canQueueDiskIOBusiness(message)) throw new Error("Disk I/O refused chat qa state publication.");
  return message;
}

/**
 * 登记 revision 并投递；热表此时已发布最终值。投递失败只记日志，未 ACK 的
 * revision 留给 Worker 重建时重放，口径同 chatStateStorage.ts 的 queueChatStateWrite。
 */
function queueChatQaWrite(message: ChatQaWriteDiskMessage): void {
  nextChatQaRevision.current = message.revision;
  trackUnacknowledged(message);
  if (!postWithTransport(message)) {
    logger.error(
      `Failed to queue chat qa for chat ${message.chatId}; retaining revision ${message.revision} for replay.`
    );
  }
}

/**
 * 写入一条问答的最终值。
 *
 * @returns 已存在同一问题时为 `"replaced"`，新增为 `"created"`；容量已满则抛错。
 *   回执按这个结果措辞（见 docs/cn/04-invariants.md 的回执口径）。
 */
export function setChatQa(chatId: number, q: string, a: string): "created" | "replaced" {
  const existing: Map<string, string> | undefined = chatQaEntries.get(chatId);
  const questions: Map<string, string> = existing ?? new Map<string, string>();
  const replaced: boolean = questions.has(q);
  if (!replaced && questions.size >= CHAT_QA_MAX_PER_CHAT) {
    throw new ChatQaCapacityError(
      `${IDENTITY_DATABASE_PATH}:chat_qa must contain at most ` +
      `${CHAT_QA_MAX_PER_CHAT} entries per chat; remove one before adding another.`
    );
  }
  const message: ChatQaWriteDiskMessage = prepareChatQaWrite(chatId, q, a);
  questions.set(q, a);
  if (existing === undefined) chatQaEntries.set(chatId, questions);
  queueChatQaWrite(message);
  return replaced ? "replaced" : "created";
}

/** 删除一条问答；返回是否真的删掉了，用于让回执如实措辞。 */
export function removeChatQa(chatId: number, q: string): boolean {
  const questions: Map<string, string> | undefined = chatQaEntries.get(chatId);
  if (questions?.has(q) !== true) return false;
  const message: ChatQaWriteDiskMessage = prepareChatQaWrite(chatId, q, undefined);
  questions.delete(q);
  // 空表不留存，直答路径第一步的 `get(chatId)` 靠 undefined 短路。
  if (questions.size === 0) chatQaEntries.delete(chatId);
  queueChatQaWrite(message);
  return true;
}

/**
 * 群 teardown 的整群删除：删掉本群全部已登记问答。
 *
 * 逐条发墓碑，复用 setChatQa/removeChatQa 的准入、revision 与重放路径。
 *
 * 与 `/qa remove` 同样只排进事务缓冲、不在这里等 durable 回执：调用方
 * （commands/qa.ts 的 teardownQaInChat）所在的 `/init disable` 与离群路径在 teardown
 * 之后各自紧跟一次 persistChatState，两者共用同一个 SQLite 事务与 flush。
 *
 * @returns 实际删掉的条数；没有登记过问答的群为 0，且不产生任何投递。
 */
export function removeAllChatQa(chatId: number): number {
  const questions: Map<string, string> | undefined = chatQaEntries.get(chatId);
  if (questions === undefined) return 0;
  let removed: number = 0;
  try {
    // 先取键快照；循环就地修改 questions。
    for (const q of [...questions.keys()]) {
      const message: ChatQaWriteDiskMessage = prepareChatQaWrite(chatId, q, undefined);
      questions.delete(q);
      queueChatQaWrite(message);
      removed++;
    }
  } finally {
    // 空表不留存，同 removeChatQa。放在 finally 中，中途抛错时按此刻的 size 判定：
    // 已摘走的条目不回表，剩余条目保留。
    if (questions.size === 0) chatQaEntries.delete(chatId);
  }
  return removed;
}

/** 收到精确 ACK 后清掉对应未确认 revision；迟到的 ACK 不得清掉更新的写。 */
function settleChatQaWrites(reply: IdentityStoragePersistedReply): void {
  for (const write of reply.chatQaWrites) {
    const questions: Map<string, UnacknowledgedChatQaWrite> | undefined =
      unacknowledgedChatQaWrites.get(write.chatId);
    if (questions === undefined) continue;
    const pending: UnacknowledgedChatQaWrite | undefined = questions.get(write.q);
    if (pending?.revision === write.revision) {
      questions.delete(write.q);
      unacknowledgedChatQaTotals.entries--;
      unacknowledgedChatQaTotals.bytes -= pending.bytes;
    }
    if (questions.size === 0) unacknowledgedChatQaWrites.delete(write.chatId);
  }
}

/** Worker 重建后按内存最终值重放全部未确认写；正文从热表现编码。 */
function replayChatQaWrites(transport: DiskIORecoveryTransport): boolean {
  for (const [chatId, questions] of unacknowledgedChatQaWrites) {
    for (const [q, pending] of questions) {
      const answer: string | undefined = chatQaEntries.get(chatId)?.get(q);
      const data: string | null = answer === undefined
        ? null
        : encodeChatQaData(answer, `${IDENTITY_DATABASE_PATH}:chat_qa[${chatId}]`);
      if (!postWithTransport({ type: "chatQaWrite", chatId, q, data, revision: pending.revision }, transport)) {
        return false;
      }
    }
  }
  return true;
}

diskIO.onDiskIOReply("identityStoragePersisted", settleChatQaWrites);
diskIO.onDiskIORespawn(
  "chat qa",
  DISK_IO_RESPAWN_PRIORITIES.CHAT_QA,
  replayChatQaWrites
);
