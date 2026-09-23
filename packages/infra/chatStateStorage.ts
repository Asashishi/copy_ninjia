/**
 * 主线程群状态持久化边界：至多 25 项的 chatStateCache 是唯一热读副本，SQLite 是
 * 权威落盘源。
 *
 * 写入先发布热读副本最终值，再只保留 revision 与删除墓碑，正文不复制到第二张主线程
 * Map；Disk I/O Worker 崩溃后从热读副本重编码并重放未 ACK revision。
 */

import { assertStorageAdmission } from "./diskIO/storageAdmission";
import { canQueueDiskIOBusiness } from "./diskIO/transport";
import { describeFlushFailure, postWithTransport } from "./diskIO/businessWrite";
import { storageWriteCost } from "../libs/storageWriteBudget";
import {
  chatStateCache,
  chatStateWriteRevision,
  resetChatStateCache,
  unacknowledgedChatStateWrites,
} from "../cache/main/chatState";
import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { IDENTITY_DATABASE_PATH } from "../consts/paths";
import { DISK_IO_RESPAWN_PRIORITIES } from "../consts/diskIO/common";
import {
  assertTelegramChatId,
  encodeChatStateData,
} from "../database/codec/chatState";
import {
  adoptChatState,
  isEmptyChatState,
  normalizeChatState,
} from "../libs/chatState";
import * as diskIO from "./diskIO";
import { logger } from "./logger";
import { throwIfUpdateAborted } from "./updateContext";
import type { ChatState } from "../types/chatState";
import type {
  ChatStateWriteDiskMessage,
  DiskIORecoveryTransport,
} from "../types/diskIO/messages";
import type {
  DomainFlushOutcome,
  IdentityStoragePersistedReply,
} from "../types/diskIO/replies";
import type { UnacknowledgedChatStateWrite } from "../types/identityStorage";

interface EncodedChatStateWrite {
  readonly data: string | null;
  readonly deleted: boolean;
  readonly aiPersona: string | null;
}

interface QueuedChatStateWrite {
  readonly chatId: number;
  readonly revision: number;
}

function capacityError(): Error {
  return new Error(
    `${IDENTITY_DATABASE_PATH}:chat_states must contain at most ${STATE_MANAGED_CHAT_LIMIT} chats; ` +
    "delete chats that are no longer managed before adding another chat."
  );
}

/** 启动恢复信任 SQLite 当前写入边界，只把持久化值搬进固定 shape 的热读副本。 */
export function hydrateChatStateCache(states: ReadonlyMap<number, ChatState>): void {
  resetChatStateCache();
  for (const [chatId, decoded] of states) {
    const state: ChatState = adoptChatState(decoded);
    normalizeChatState(state);
    chatStateCache.set(chatId, state);
  }
}

/** 新建群状态前执行容量闸；第 26 个群直接拒绝，热读副本不淘汰权威记录。 */
export function assertChatStateCapacity(chatId: number): void {
  assertTelegramChatId(chatId, "chat state cache");
  if (!chatStateCache.has(chatId) && chatStateCache.size >= STATE_MANAGED_CHAT_LIMIT) {
    throw capacityError();
  }
}

function encodeCurrentChatState(chatId: number): EncodedChatStateWrite {
  const state: ChatState | undefined = chatStateCache.get(chatId);
  if (state === undefined) return { data: null, deleted: true, aiPersona: null };
  normalizeChatState(state);
  if (isEmptyChatState(state)) return { data: null, deleted: true, aiPersona: null };
  return {
    data: encodeChatStateData(state, `chat state ${chatId}`),
    deleted: false,
    aiPersona: state.aiPersona ?? null,
  };
}

/** 把一群当前最终值排进 SQLite；返回本次 revision 供 durability barrier 核对。 */
export function queueChatStateWrite(chatId: number): number {
  assertTelegramChatId(chatId, "chat state write");
  if (!Number.isSafeInteger(chatStateWriteRevision.current + 1)) {
    throw new Error("Chat-state revision space is exhausted.");
  }
  const encoded: EncodedChatStateWrite = encodeCurrentChatState(chatId);
  const revision: number = chatStateWriteRevision.current + 1;
  const message: ChatStateWriteDiskMessage = {
    type: "chatStateWrite",
    chatId,
    data: encoded.data,
    aiPersona: encoded.aiPersona,
    revision,
  };
  let bytes: number = storageWriteCost(encoded.data) + storageWriteCost(encoded.aiPersona);
  for (const pendingChatId of unacknowledgedChatStateWrites.keys()) {
    if (pendingChatId === chatId) continue;
    const state: ChatState | undefined = chatStateCache.get(pendingChatId);
    bytes += storageWriteCost(state === undefined ? null : encodeChatStateData(state, "chat state admission")) + storageWriteCost(state?.aiPersona ?? null);
  }
  assertStorageAdmission(unacknowledgedChatStateWrites.size + (unacknowledgedChatStateWrites.has(chatId) ? 0 : 1), bytes);
  if (!canQueueDiskIOBusiness(message)) throw new Error("Disk I/O refused chat state publication.");
  // 准入通过后才摘除已空的群状态：闸抛错时热读副本与未 ACK 记账都保持调用前原样。
  if (encoded.deleted) chatStateCache.delete(chatId);
  chatStateWriteRevision.current = revision;
  unacknowledgedChatStateWrites.set(chatId, { revision, deleted: encoded.deleted });
  if (!postWithTransport(message)) {
    logger.error(
      `Failed to queue chat state ${chatId}; retaining revision ${revision} for replay.`
    );
  }
  return revision;
}

/** 一群权威更新的 durable 屏障；目标 revision 收到精确事务 ACK 后才返回。 */
export async function persistChatState(chatId: number, context: string): Promise<void> {
  throwIfUpdateAborted();
  const revision: number = queueChatStateWrite(chatId);
  const outcome: DomainFlushOutcome = await diskIO.flushDiskIODomainOutcome("chatState");
  throwIfUpdateAborted();
  if (outcome.result !== "flushed") {
    throw new Error(
      `Failed to persist chat state update (${context}): flush ${outcome.result} for ` +
      `chat ${chatId} revision ${revision}; ${describeFlushFailure(outcome)}.`
    );
  }
  if (unacknowledgedChatStateWrites.get(chatId)?.revision === revision) {
    throw new Error(
      `Failed to persist chat state update (${context}): Worker did not acknowledge ` +
      `chat ${chatId} revision ${revision}.`
    );
  }
}

/** 低优先级群状态变化：入事务缓冲后立即返回，失败由统一重放与 flush 负责。 */
export function saveChatStateInBackground(chatId: number, context: string): void {
  throwIfUpdateAborted();
  try {
    queueChatStateWrite(chatId);
  } catch (error: unknown) {
    logger.error(`Failed to persist background chat state update (${context}):`, error);
  }
}

function settleChatStateWrites(reply: IdentityStoragePersistedReply): void {
  for (const persisted of reply.chatStateWrites) {
    if (
      unacknowledgedChatStateWrites.get(persisted.chatId)?.revision === persisted.revision
    ) {
      unacknowledgedChatStateWrites.delete(persisted.chatId);
    }
  }
}

function replayChatStateWrites(transport: DiskIORecoveryTransport): boolean {
  const writes: QueuedChatStateWrite[] = [];
  for (const [chatId, pending] of unacknowledgedChatStateWrites) {
    writes.push({ chatId, revision: pending.revision });
  }
  writes.sort((left: QueuedChatStateWrite, right: QueuedChatStateWrite): number =>
    left.revision - right.revision);
  for (const write of writes) {
    const encoded: EncodedChatStateWrite = encodeCurrentChatState(write.chatId);
    const current: UnacknowledgedChatStateWrite | undefined =
      unacknowledgedChatStateWrites.get(write.chatId);
    if (current?.revision !== write.revision) continue;
    if (current.deleted !== encoded.deleted) {
      unacknowledgedChatStateWrites.set(write.chatId, {
        revision: current.revision,
        deleted: encoded.deleted,
      });
    }
    const message: ChatStateWriteDiskMessage = {
      type: "chatStateWrite",
      chatId: write.chatId,
      data: encoded.data,
      aiPersona: encoded.aiPersona,
      revision: write.revision,
    };
    if (!postWithTransport(message, transport)) return false;
  }
  return true;
}

diskIO.onDiskIOReply("identityStoragePersisted", settleChatStateWrites);
diskIO.onDiskIORespawn(
  "chat state",
  DISK_IO_RESPAWN_PRIORITIES.CHAT_STATE,
  replayChatStateWrites
);
