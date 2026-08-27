/**
 * 主线程群状态持久化边界：25 项 LRU 是唯一热读副本，SQLite 是权威落盘源。
 *
 * 写入先发布 LRU 最终值，再只保留 revision 与删除墓碑，正文不复制到第二张主线程
 * Map；Disk I/O Worker 崩溃后从 LRU 重编码并重放未 ACK revision。
 */

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

interface ChatStateDiskIOApi {
  readonly flushDiskIODomainOutcome?: typeof diskIO.flushDiskIODomainOutcome;
  readonly onDiskIORespawn?: typeof diskIO.onDiskIORespawn;
  readonly onIdentityStoragePersisted?: typeof diskIO.onIdentityStoragePersisted;
  readonly postDiskIO?: typeof diskIO.postDiskIO;
}

interface EncodedChatStateWrite {
  readonly data: string | null;
  readonly deleted: boolean;
}

interface QueuedChatStateWrite {
  readonly chatId: number;
  readonly revision: number;
}

// 叶子单测可只替换实际观察的出口；生产装配始终提供完整接口。
const chatStateDiskIOApi: ChatStateDiskIOApi = diskIO;

function capacityError(): Error {
  return new Error(
    `${IDENTITY_DATABASE_PATH}:chat_states must contain at most ${STATE_MANAGED_CHAT_LIMIT} chats; ` +
    "delete chats that are no longer managed before adding another chat."
  );
}

/** 启动恢复信任 SQLite 当前写入边界，只把持久化值搬进固定 shape LRU。 */
export function hydrateChatStateCache(states: ReadonlyMap<number, ChatState>): void {
  resetChatStateCache();
  for (const [chatId, decoded] of states) {
    const state: ChatState = adoptChatState(decoded);
    normalizeChatState(state);
    chatStateCache.set(chatId, state);
  }
}

/** 新建群状态前执行容量闸；LRU 绝不通过淘汰掩盖第 26 条权威记录。 */
export function assertChatStateCapacity(chatId: number): void {
  assertTelegramChatId(chatId, "chat state cache");
  if (!chatStateCache.has(chatId) && chatStateCache.size >= STATE_MANAGED_CHAT_LIMIT) {
    throw capacityError();
  }
}

function encodeCurrentChatState(chatId: number): EncodedChatStateWrite {
  const state: ChatState | undefined = chatStateCache.peek(chatId);
  if (state === undefined) return { data: null, deleted: true };
  normalizeChatState(state);
  if (isEmptyChatState(state)) {
    chatStateCache.delete(chatId);
    return { data: null, deleted: true };
  }
  return {
    data: encodeChatStateData(state, `chat state ${chatId}`),
    deleted: false,
  };
}

function postChatStateWrite(
  message: ChatStateWriteDiskMessage,
  transport?: DiskIORecoveryTransport
): boolean {
  return transport === undefined
    ? chatStateDiskIOApi.postDiskIO?.(message) === true
    : transport.post(message);
}

/** 把一群当前最终值排进 SQLite；返回本次 revision 供 durability barrier 核对。 */
export function queueChatStateWrite(chatId: number): number {
  assertTelegramChatId(chatId, "chat state write");
  if (!Number.isSafeInteger(chatStateWriteRevision.current + 1)) {
    throw new Error("Chat-state revision space is exhausted.");
  }
  const encoded: EncodedChatStateWrite = encodeCurrentChatState(chatId);
  chatStateWriteRevision.current++;
  const revision: number = chatStateWriteRevision.current;
  unacknowledgedChatStateWrites.set(chatId, {
    revision,
    deleted: encoded.deleted,
  });
  const message: ChatStateWriteDiskMessage = {
    type: "chatStateWrite",
    chatId,
    data: encoded.data,
    revision,
  };
  if (!postChatStateWrite(message)) {
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
  const flush: typeof diskIO.flushDiskIODomainOutcome | undefined =
    chatStateDiskIOApi.flushDiskIODomainOutcome;
  if (flush === undefined) {
    throw new Error(`Failed to persist chat state update (${context}): persistence flush is unavailable.`);
  }
  const outcome: DomainFlushOutcome = await flush("chatState");
  throwIfUpdateAborted();
  if (outcome.result !== "flushed") {
    const domainNote: string = outcome.failedDomains === undefined
      ? "no per-domain reply"
      : `failed domains: ${outcome.failedDomains.join(", ")}`;
    throw new Error(
      `Failed to persist chat state update (${context}): flush ${outcome.result} for ` +
      `chat ${chatId} revision ${revision}; ${domainNote}.`
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
      revision: write.revision,
    };
    if (!postChatStateWrite(message, transport)) return false;
  }
  return true;
}

if (chatStateDiskIOApi.onIdentityStoragePersisted !== undefined) {
  chatStateDiskIOApi.onIdentityStoragePersisted(settleChatStateWrites);
}
if (chatStateDiskIOApi.onDiskIORespawn !== undefined) {
  chatStateDiskIOApi.onDiskIORespawn(
    "chat state",
    DISK_IO_RESPAWN_PRIORITIES.CHAT_STATE,
    replayChatStateWrites
  );
}
