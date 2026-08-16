import {
  pendingBlocklistWrites,
  pendingChatStateWrites,
  pendingRemovalSnapshotRevision,
  pendingRemovalWrites,
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
  ChatStatePersistedRevision,
  IdentityPersistenceReply,
  IdentityPolicyPersistedRevision,
} from "../../../types/diskIO";
import type {
  PendingChatStateWrite,
  PendingIdentityPolicyWrite,
  PendingRemovalWrite,
} from "../../../types/identityStorage";
import { requireStorageDatabase } from "./context";

/** 任一共享 SQLite 业务表存在待提交最终值时返回 true。 */
export function hasPendingStorageWrites(): boolean {
  return pendingWhitelistWrites.size > 0 ||
    pendingBlocklistWrites.size > 0 ||
    pendingRemovalWrites.size > 0 ||
    pendingChatStateWrites.size > 0;
}

function armStorageFlushTimer(): void {
  if (!hasPendingStorageWrites() || storageWriteFlushTimer.current !== null) return;
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
  }, IDENTITY_WRITE_FLUSH_INTERVAL_MS);
  storageWriteFlushTimer.current.unref();
}

/** 任一领域达到容量即提交全部领域，否则为首条变化建立固定截止 timer。 */
export function flushIfStorageFull(reply: IdentityPersistenceReply): void {
  if (
    pendingWhitelistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingBlocklistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingRemovalWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
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
        chatStateWrites: [],
        removalSnapshotRevision: removalRevision,
      });
    }
    return !rejected;
  }
  if (storageWriteFlushTimer.current !== null) {
    clearTimeout(storageWriteFlushTimer.current);
    storageWriteFlushTimer.current = null;
  }
  const whitelist: Map<number, PendingIdentityPolicyWrite> = new Map(pendingWhitelistWrites);
  const blocklist: Map<number, PendingIdentityPolicyWrite> = new Map(pendingBlocklistWrites);
  const removals: Map<number, PendingRemovalWrite> = new Map(pendingRemovalWrites);
  const chatStates: Map<number, PendingChatStateWrite> = new Map(pendingChatStateWrites);
  const removalRevision: number | null = pendingRemovalSnapshotRevision.current;
  try {
    commitStorageDatabaseChanges(requireStorageDatabase(), {
      whitelist,
      blocklist,
      removals,
      chatStates,
    });
  } catch (error: unknown) {
    console.error("[diskIOWorker] storage database transaction failed:", error);
    armStorageFlushTimer();
    return false;
  }
  const acknowledgements: IdentityPolicyPersistedRevision[] = [];
  const chatStateAcknowledgements: ChatStatePersistedRevision[] = [];
  for (const [id, change] of whitelist) {
    if (pendingWhitelistWrites.get(id) === change) pendingWhitelistWrites.delete(id);
    acknowledgements.push({ table: "whitelist", id, revision: change.revision });
  }
  for (const [id, change] of blocklist) {
    if (pendingBlocklistWrites.get(id) === change) pendingBlocklistWrites.delete(id);
    acknowledgements.push({ table: "blocklist", id, revision: change.revision });
  }
  for (const [id, change] of removals) {
    if (pendingRemovalWrites.get(id) === change) pendingRemovalWrites.delete(id);
  }
  for (const [chatId, change] of chatStates) {
    if (pendingChatStateWrites.get(chatId) === change) pendingChatStateWrites.delete(chatId);
    chatStateAcknowledgements.push({ chatId, revision: change.revision });
  }
  if (pendingRemovalSnapshotRevision.current === removalRevision) {
    pendingRemovalSnapshotRevision.current = null;
  }
  reply({
    type: "identityStoragePersisted",
    writes: acknowledgements,
    chatStateWrites: chatStateAcknowledgements,
    ...(removalRevision === null ? {} : { removalSnapshotRevision: removalRevision }),
  });
  armStorageFlushTimer();
  return !rejected;
}

/** 取走拒收标记，并叠加本轮仍 dirty 的表，供统一 flush 返回精确失败领域。 */
export function pendingStorageDatabaseDomains(): readonly (
  "whitelist" | "blocklist" | "blocklistRemovalOutbox" | "chatState"
)[] {
  const domains: Set<"whitelist" | "blocklist" | "blocklistRemovalOutbox" | "chatState"> =
    new Set(rejectedStorageDomains);
  rejectedStorageDomains.clear();
  if (pendingWhitelistWrites.size > 0) domains.add("whitelist");
  if (pendingBlocklistWrites.size > 0) domains.add("blocklist");
  if (pendingRemovalWrites.size > 0) domains.add("blocklistRemovalOutbox");
  if (pendingChatStateWrites.size > 0) domains.add("chatState");
  return [...domains];
}

/** Worker 启动时安装事务 ACK 通道，供 30 秒 timer 复用。 */
export function configureStoragePersistenceReply(
  reply: IdentityPersistenceReply
): void {
  storagePersistenceReplyHolder.current = reply;
}
