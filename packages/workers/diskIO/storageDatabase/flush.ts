import { STORAGE_WRITE_MAX_FAILURES } from "../../../consts/diskIO/business";
import {
  storagePendingBudget,
  storageWriteRetry,
  storageWriteFatalReply,
  pendingBlocklistWrites,
  pendingChatQaWrites,
  pendingChatStateWrites,
  pendingRemovalSnapshotRevision,
  pendingRemovalWrites,
  pendingTemporaryWhitelistWrites,
  pendingWhitelistWrites,
  rejectedStorageDomains,
  storagePersistenceReplyHolder,
  storageWriteFlushTimer,
} from "../../../cache/workers/diskIO/storageDatabase";
import {
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
  IDENTITY_WRITE_FLUSH_INTERVAL_MS,
} from "../../../consts/identityStorage";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../consts/storage";
import { commitStorageDatabaseChanges } from "../../../database/interact/transaction";
import type {
  ChatQaPersistedRevision,
  ChatStatePersistedRevision,
  IdentityPersistenceReply,
  IdentityPolicyPersistedRevision,
  TemporaryWhitelistPersistedRevision,
} from "../../../types/diskIO/replies";
import type {
  PendingChatQaWrite,
  PendingChatStateWrite,
  PendingIdentityPolicyWrite,
  PendingRemovalWrite,
} from "../../../types/identityStorage";
import type { PendingTemporaryWhitelistWrite } from
  "../../../types/temporaryWhitelist";
import { requireStorageDatabase } from "./context";

/** 任一共享 SQLite 业务表存在待提交最终值时返回 true。 */
export function hasPendingStorageWrites(): boolean {
  return pendingWhitelistWrites.size > 0 ||
    pendingBlocklistWrites.size > 0 ||
    pendingTemporaryWhitelistWrites.size > 0 ||
    pendingRemovalWrites.size > 0 ||
    pendingChatStateWrites.size > 0 ||
    pendingChatQaWrites.size > 0;
}

function armStorageFlushTimer(): void {
  if (!hasPendingStorageWrites() || storageWriteFlushTimer.current !== null || storageWriteRetry.signaled) return;
  storageWriteFlushTimer.current = setTimeout((): void => {
    storageWriteFlushTimer.current = null;
    const reply: IdentityPersistenceReply | null = storagePersistenceReplyHolder.current;
    if (reply === null) {
      console.error("[diskIOWorker] storage database flush reply channel is unavailable.");
      armStorageFlushTimer();
      return;
    }
    if (!flushStorageDatabase(reply)) {
      console.error(
        "[diskIOWorker] failed to flush the storage database; retaining pending changes for retry."
      );
      armStorageFlushTimer();
    }
  }, Math.max(IDENTITY_WRITE_FLUSH_INTERVAL_MS, storageWriteRetry.retryAt - performance.now()));
  storageWriteFlushTimer.current.unref();
}

/**
 * 任一领域达到批次阈值即提交全部领域，否则为首条变化建立固定截止 timer。
 * 事务失败后新输入仅合并最终值，由有界退避 timer 重试；条目和字节预算独立执行。
 */
export function flushIfStorageFull(reply: IdentityPersistenceReply): void {
  if (storageWriteRetry.failures > 0) { armStorageFlushTimer(); return; }
  if (
    pendingWhitelistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingBlocklistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingTemporaryWhitelistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingRemovalWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingChatQaWrites.size >= STATE_MANAGED_CHAT_LIMIT ||
    pendingChatStateWrites.size >= STATE_MANAGED_CHAT_LIMIT
  ) {
    if (!flushStorageDatabase(reply)) armStorageFlushTimer();
    return;
  }
  armStorageFlushTimer();
}

/**
 * 当前各表待写值在一个显式事务中提交；成功后才清缓冲并回 ACK。
 * @returns true 表示本轮全部变化已 durable 或本来无变化。
 */
export function flushStorageDatabase(reply: IdentityPersistenceReply): boolean {
  const rejected: boolean = rejectedStorageDomains.size > 0;
  if (!hasPendingStorageWrites()) {
    const removalRevision: number | null = pendingRemovalSnapshotRevision.current;
    if (removalRevision !== null) {
      pendingRemovalSnapshotRevision.current = null;
      reply({
        type: "identityStoragePersisted",
        writes: [],
        temporaryWhitelistWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
        removalSnapshotRevision: removalRevision,
      });
    }
    return !rejected;
  }
  if (storageWriteFlushTimer.current !== null) {
    clearTimeout(storageWriteFlushTimer.current);
    storageWriteFlushTimer.current = null;
  }
  // Bun SQLite 事务同步执行；清空与 ACK 回调之间不让出本 isolate。
  const whitelist: Map<number, PendingIdentityPolicyWrite> = pendingWhitelistWrites;
  const blocklist: Map<number, PendingIdentityPolicyWrite> = pendingBlocklistWrites;
  const temporaryWhitelist: Map<number, PendingTemporaryWhitelistWrite> = pendingTemporaryWhitelistWrites;
  const removals: Map<number, PendingRemovalWrite> = pendingRemovalWrites;
  const chatStates: Map<number, PendingChatStateWrite> = pendingChatStateWrites;
  const chatQaChanges: Map<number, Map<string, PendingChatQaWrite>> = pendingChatQaWrites;
  const removalRevision: number | null = pendingRemovalSnapshotRevision.current;
  try {
    commitStorageDatabaseChanges(requireStorageDatabase(), {
      whitelist,
      blocklist,
      temporaryWhitelist,
      removals,
      chatStates,
      chatQa: chatQaChanges,
    });
  } catch (error: unknown) {
    console.error("[diskIOWorker] storage database transaction failed:", error);
    storageWriteRetry.failures++;
    storageWriteRetry.retryAt = performance.now() + IDENTITY_WRITE_FLUSH_INTERVAL_MS * storageWriteRetry.failures;
    if (storageWriteRetry.failures >= STORAGE_WRITE_MAX_FAILURES && !storageWriteRetry.signaled) {
      storageWriteRetry.signaled = true;
      storageWriteFatalReply.current?.();
    }
    armStorageFlushTimer();
    return false;
  }
  storagePendingBudget.reset();
  storageWriteRetry.failures = 0;
  storageWriteRetry.retryAt = 0;
  storageWriteRetry.signaled = false;
  const acknowledgements: IdentityPolicyPersistedRevision[] = [];
  const temporaryWhitelistAcknowledgements: TemporaryWhitelistPersistedRevision[] = [];
  const chatStateAcknowledgements: ChatStatePersistedRevision[] = [];
  const chatQaAcknowledgements: ChatQaPersistedRevision[] = [];
  for (const [id, change] of whitelist) {
    if (pendingWhitelistWrites.get(id) === change) pendingWhitelistWrites.delete(id);
    acknowledgements.push({ table: "whitelist", id, revision: change.revision });
  }
  for (const [id, change] of blocklist) {
    if (pendingBlocklistWrites.get(id) === change) pendingBlocklistWrites.delete(id);
    acknowledgements.push({ table: "blocklist", id, revision: change.revision });
  }
  for (const [id, change] of temporaryWhitelist) {
    if (pendingTemporaryWhitelistWrites.get(id) === change) {
      pendingTemporaryWhitelistWrites.delete(id);
    }
    temporaryWhitelistAcknowledgements.push({ id, revision: change.revision });
  }
  for (const [id, change] of removals) {
    if (pendingRemovalWrites.get(id) === change) pendingRemovalWrites.delete(id);
  }
  for (const [chatId, change] of chatStates) {
    if (pendingChatStateWrites.get(chatId) === change) pendingChatStateWrites.delete(chatId);
    chatStateAcknowledgements.push({ chatId, revision: change.revision });
  }
  for (const [chatId, questions] of chatQaChanges) {
    const pending: Map<string, PendingChatQaWrite> | undefined =
      pendingChatQaWrites.get(chatId);
    if (pending === undefined) continue;
    for (const [q, change] of questions) {
      if (pending.get(q) === change) pending.delete(q);
      chatQaAcknowledgements.push({ chatId, q, revision: change.revision });
    }
    // 空 Map 不留存，否则每个曾登记过问答的群都会在缓冲里留一项空壳。
    if (pending.size === 0) pendingChatQaWrites.delete(chatId);
  }
  if (pendingRemovalSnapshotRevision.current === removalRevision) {
    pendingRemovalSnapshotRevision.current = null;
  }
  reply({
    type: "identityStoragePersisted",
    writes: acknowledgements,
    temporaryWhitelistWrites: temporaryWhitelistAcknowledgements,
    chatStateWrites: chatStateAcknowledgements,
    chatQaWrites: chatQaAcknowledgements,
    ...(removalRevision === null ? {} : { removalSnapshotRevision: removalRevision }),
  });
  armStorageFlushTimer();
  return !rejected;
}

/** 取走拒收标记，并叠加本轮仍 dirty 的表，供统一 flush 返回精确失败领域。 */
export function pendingStorageDatabaseDomains(): readonly (
  "whitelist" | "blocklist" | "temporaryWhitelist" | "blocklistRemovalOutbox" | "chatState" | "chatQa"
)[] {
  const domains: Set<
    "whitelist" | "blocklist" | "temporaryWhitelist" | "blocklistRemovalOutbox" | "chatState" | "chatQa"
  > = new Set(rejectedStorageDomains);
  rejectedStorageDomains.clear();
  if (pendingWhitelistWrites.size > 0) domains.add("whitelist");
  if (pendingBlocklistWrites.size > 0) domains.add("blocklist");
  if (pendingTemporaryWhitelistWrites.size > 0) domains.add("temporaryWhitelist");
  if (pendingRemovalWrites.size > 0) domains.add("blocklistRemovalOutbox");
  if (pendingChatStateWrites.size > 0) domains.add("chatState");
  if (pendingChatQaWrites.size > 0) domains.add("chatQa");
  return [...domains];
}

/** Worker 启动时安装事务 ACK 通道，供 30 秒 timer 复用。 */
export function configureStoragePersistenceReply(
  reply: IdentityPersistenceReply
): void {
  storagePersistenceReplyHolder.current = reply;
}
