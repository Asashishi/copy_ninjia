/**
 * 主线程群问答持久化边界：内存 Map 是唯一热读副本，SQLite 是权威落盘源。
 *
 * 写入先发布内存最终值，再只保留 revision，正文不复制到第二张主线程表；
 * Disk I/O Worker 崩溃后从内存重编码并重放未 ACK 的 revision。语义与
 * infra/chatStateStorage.ts 一致，只是主键换成 (chatId, q) 复合键。
 */

import {
  chatQaEntries,
  nextChatQaRevision,
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

interface ChatQaDiskIOApi {
  readonly onDiskIORespawn?: typeof diskIO.onDiskIORespawn;
  readonly onIdentityStoragePersisted?: typeof diskIO.onIdentityStoragePersisted;
  readonly postDiskIO?: typeof diskIO.postDiskIO;
}

// 叶子单测可只替换实际观察的出口；生产装配始终提供完整接口。
const chatQaDiskIOApi: ChatQaDiskIOApi = diskIO;

/** 启动恢复信任 SQLite 当前写入边界，只把持久化值搬进内存。 */
export function hydrateChatQaCache(
  entries: ReadonlyMap<number, ReadonlyMap<string, string>>
): void {
  chatQaEntries.clear();
  unacknowledgedChatQaWrites.clear();
  for (const [chatId, questions] of entries) {
    if (questions.size === 0) continue;
    chatQaEntries.set(chatId, new Map(questions));
  }
}

/**
 * 读取某群的问答表。
 *
 * 直答路径每条群消息调它一次，因此**不做任何投影**：直接交出内部 Map 的只读
 * 视图，调用方按 `message.text` 查一次即可，不产生临时对象。没有问答的群返回
 * undefined，调用方据此在第一步就走开。
 */
export function getChatQa(chatId: number): ReadonlyMap<string, string> | undefined {
  return chatQaEntries.get(chatId);
}

/** 本群已登记条数；`/set_qa` 的容量闸与 `/query_qa` 的渲染共用。 */
export function chatQaCount(chatId: number): number {
  return chatQaEntries.get(chatId)?.size ?? 0;
}

function postChatQaWrite(
  message: ChatQaWriteDiskMessage,
  transport?: DiskIORecoveryTransport
): boolean {
  return transport === undefined
    ? chatQaDiskIOApi.postDiskIO?.(message) === true
    : transport.post(message);
}

function trackUnacknowledged(chatId: number, q: string, revision: number): void {
  const existing: Map<string, number> | undefined = unacknowledgedChatQaWrites.get(chatId);
  const questions: Map<string, number> = existing ?? new Map<string, number>();
  if (existing === undefined) unacknowledgedChatQaWrites.set(chatId, questions);
  questions.set(q, revision);
}

/** 把一条问答的当前最终值排进 SQLite；返回本次 revision 供 durability barrier 核对。 */
function queueChatQaWrite(chatId: number, q: string): number {
  if (!Number.isSafeInteger(nextChatQaRevision.current + 1)) {
    throw new Error("Chat-qa revision space is exhausted.");
  }
  const answer: string | undefined = chatQaEntries.get(chatId)?.get(q);
  const data: string | null = answer === undefined
    ? null
    : encodeChatQaData(answer, `${IDENTITY_DATABASE_PATH}:chat_qa[${chatId}]`);
  nextChatQaRevision.current++;
  const revision: number = nextChatQaRevision.current;
  trackUnacknowledged(chatId, q, revision);
  if (!postChatQaWrite({ type: "chatQaWrite", chatId, q, data, revision })) {
    logger.error(
      `Failed to queue chat qa for chat ${chatId}; retaining revision ${revision} for replay.`
    );
  }
  return revision;
}

/**
 * 写入一条问答的最终值。
 *
 * @returns 已存在同一问题时为 `"replaced"`，新增为 `"created"`；容量已满则抛错。
 *   回执必须按这个结果措辞——把「覆盖了旧答案」说成「新增」会让人以为原来那条
 *   还在（见 docs/cn/04-invariants.md 的回执口径）。
 */
export function setChatQa(chatId: number, q: string, a: string): "created" | "replaced" {
  const existing: Map<string, string> | undefined = chatQaEntries.get(chatId);
  const questions: Map<string, string> = existing ?? new Map<string, string>();
  const replaced: boolean = questions.has(q);
  if (!replaced && questions.size >= CHAT_QA_MAX_PER_CHAT) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}:chat_qa must contain at most ` +
      `${CHAT_QA_MAX_PER_CHAT} entries per chat; remove one before adding another.`
    );
  }
  questions.set(q, a);
  if (existing === undefined) chatQaEntries.set(chatId, questions);
  queueChatQaWrite(chatId, q);
  return replaced ? "replaced" : "created";
}

/** 删除一条问答；返回是否真的删掉了，用于让回执如实措辞。 */
export function removeChatQa(chatId: number, q: string): boolean {
  const questions: Map<string, string> | undefined = chatQaEntries.get(chatId);
  if (questions?.delete(q) !== true) return false;
  // 空表不留存，否则每个曾登记过问答的群都会在热表里留一项空壳，而直答路径
  // 第一步的 `get(chatId)` 就再也不能靠 undefined 短路。
  if (questions.size === 0) chatQaEntries.delete(chatId);
  queueChatQaWrite(chatId, q);
  return true;
}

/** 收到精确 ACK 后清掉对应未确认 revision；迟到的 ACK 不得清掉更新的写。 */
function settleChatQaWrites(reply: IdentityStoragePersistedReply): void {
  for (const write of reply.chatQaWrites) {
    const questions: Map<string, number> | undefined =
      unacknowledgedChatQaWrites.get(write.chatId);
    if (questions === undefined) continue;
    if (questions.get(write.q) === write.revision) questions.delete(write.q);
    if (questions.size === 0) unacknowledgedChatQaWrites.delete(write.chatId);
  }
}

/** Worker 重建后按内存最终值重放全部未确认写；正文从热表现编码。 */
function replayChatQaWrites(transport: DiskIORecoveryTransport): boolean {
  for (const [chatId, questions] of unacknowledgedChatQaWrites) {
    for (const [q, revision] of questions) {
      const answer: string | undefined = chatQaEntries.get(chatId)?.get(q);
      const data: string | null = answer === undefined
        ? null
        : encodeChatQaData(answer, `${IDENTITY_DATABASE_PATH}:chat_qa[${chatId}]`);
      if (!postChatQaWrite({ type: "chatQaWrite", chatId, q, data, revision }, transport)) {
        return false;
      }
    }
  }
  return true;
}

if (chatQaDiskIOApi.onIdentityStoragePersisted !== undefined) {
  chatQaDiskIOApi.onIdentityStoragePersisted(settleChatQaWrites);
}
if (chatQaDiskIOApi.onDiskIORespawn !== undefined) {
  chatQaDiskIOApi.onDiskIORespawn(
    "chat qa",
    DISK_IO_RESPAWN_PRIORITIES.CHAT_QA,
    replayChatQaWrites
  );
}
