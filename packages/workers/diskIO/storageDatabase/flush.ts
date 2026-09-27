import { STORAGE_WRITE_MAX_FAILURES } from "../../../consts/diskIO/business";
import {
  storagePendingBudget,
  storageWriteRetry,
  storageWriteFatalReply,
  pendingAiContextWrites,
  pendingBlocklistWrites,
  pendingChatQaEntryCount,
  pendingChatQaWrites,
  pendingChatStateWrites,
  pendingRemovalSnapshotRevision,
  pendingRemovalWrites,
  pendingTemporaryAdBypassWrites,
  pendingWhitelistWrites,
  rejectedStorageDomains,
  storagePersistenceReplyHolder,
  storageFlushHold,
  storageWriteFlushTimer,
} from "../../../cache/workers/diskIO/storageDatabase";
import {
  CHAT_QA_WRITE_BATCH_MAX_ENTRIES,
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
  TemporaryAdBypassPersistedRevision,
} from "../../../types/diskIO/replies";
import type {
  PendingAiContextWrite,
  PendingChatQaWrite,
  PendingChatStateWrite,
  PendingIdentityPolicyWrite,
  PendingRemovalWrite,
} from "../../../types/identityStorage";
import type { PendingTemporaryAdBypassWrite } from
  "../../../types/temporaryAdBypass";
import { hasUrgentAiContextWrites, settleAiContextPersisted } from "./aiContext";
import { requireStorageDatabase } from "./context";

/** 任一共享 SQLite 业务表或 AI 上下文存在待提交最终值时返回 true。 */
export function hasPendingStorageWrites(): boolean {
  return pendingWhitelistWrites.size > 0 ||
    pendingBlocklistWrites.size > 0 ||
    pendingTemporaryAdBypassWrites.size > 0 ||
    pendingRemovalWrites.size > 0 ||
    pendingChatStateWrites.size > 0 ||
    pendingChatQaWrites.size > 0 ||
    pendingAiContextWrites.size > 0;
}

/**
 * 为已排入缓冲的变化建立固定截止 timer；没有待写变化、已有 timer 或已停止自动提交时
 * 不重复装。AI 上下文的普通快照、事务失败后的退避与重放区间都走这条定时提交。
 */
export function scheduleStorageCommit(): void {
  if (!hasPendingStorageWrites() || storageWriteFlushTimer.current !== null || storageWriteRetry.signaled) return;
  storageWriteFlushTimer.current = setTimeout((): void => {
    storageWriteFlushTimer.current = null;
    if (storageFlushHold.current) {
      scheduleStorageCommit();
      return;
    }
    const reply: IdentityPersistenceReply | null = storagePersistenceReplyHolder.current;
    if (reply === null) {
      console.error("[diskIOWorker] storage database flush reply channel is unavailable.");
      scheduleStorageCommit();
      return;
    }
    if (!flushStorageDatabase(reply)) {
      console.error(
        "[diskIOWorker] failed to flush the storage database; retaining pending changes for retry."
      );
      scheduleStorageCommit();
    }
  }, Math.max(IDENTITY_WRITE_FLUSH_INTERVAL_MS, storageWriteRetry.retryAt - performance.now()));
  storageWriteFlushTimer.current.unref();
}

/**
 * AI 上下文删除与 purge 后首份快照的提交入口：立即提交全部表的待写值。镜像重放区间内、
 * 事务失败后的重试退避期内或回执通道未安装时只挂 timer：区间关闭时由 setStorageFlushHold
 * 立即提交，退避期由重试 timer 提交，不额外消耗连续失败预算。
 */
export function commitStorageUrgently(): void {
  const reply: IdentityPersistenceReply | null = storagePersistenceReplyHolder.current;
  if (storageFlushHold.current || storageWriteRetry.failures > 0 || reply === null) {
    scheduleStorageCommit();
    return;
  }
  flushStorageDatabase(reply);
}

/**
 * 任一领域达到批次阈值即提交全部领域，否则为首条变化建立固定截止 timer。
 * 事务失败后新输入仅合并最终值，由有界退避 timer 重试；条目和字节预算独立执行。
 * 镜像重放区间（storageFlushHold）内只挂 timer，不提交。
 */
export function flushIfStorageFull(reply: IdentityPersistenceReply): void {
  if (storageWriteRetry.failures > 0 || storageFlushHold.current) { scheduleStorageCommit(); return; }
  if (
    pendingWhitelistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingBlocklistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingTemporaryAdBypassWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingRemovalWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingChatQaEntryCount.current >= CHAT_QA_WRITE_BATCH_MAX_ENTRIES ||
    pendingChatStateWrites.size >= STATE_MANAGED_CHAT_LIMIT
  ) {
    if (!flushStorageDatabase(reply)) scheduleStorageCommit();
    return;
  }
  scheduleStorageCommit();
}

/**
 * 当前各表与 AI 上下文的待写值在一个显式事务中提交；成功后才清缓冲并回 ACK，AI 上下文
 * 另按 AI 记忆协议发出删除与即时写入回执。
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
        temporaryAdBypassWrites: [],
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
  const temporaryAdBypass: Map<number, PendingTemporaryAdBypassWrite> = pendingTemporaryAdBypassWrites;
  const removals: Map<number, PendingRemovalWrite> = pendingRemovalWrites;
  const chatStates: Map<number, PendingChatStateWrite> = pendingChatStateWrites;
  const chatQaChanges: Map<number, Map<string, PendingChatQaWrite>> = pendingChatQaWrites;
  const aiContexts: Map<number, PendingAiContextWrite> = pendingAiContextWrites;
  const removalRevision: number | null = pendingRemovalSnapshotRevision.current;
  try {
    commitStorageDatabaseChanges(requireStorageDatabase(), {
      whitelist,
      blocklist,
      temporaryAdBypass,
      removals,
      chatStates,
      chatQa: chatQaChanges,
      aiContexts,
    });
  } catch (error: unknown) {
    console.error("[diskIOWorker] storage database transaction failed:", error);
    storageWriteRetry.failures++;
    storageWriteRetry.retryAt = performance.now() + IDENTITY_WRITE_FLUSH_INTERVAL_MS * storageWriteRetry.failures;
    if (storageWriteRetry.failures >= STORAGE_WRITE_MAX_FAILURES && !storageWriteRetry.signaled) {
      storageWriteRetry.signaled = true;
      storageWriteFatalReply.current?.();
    }
    scheduleStorageCommit();
    return false;
  }
  storagePendingBudget.reset();
  storageWriteRetry.failures = 0;
  storageWriteRetry.retryAt = 0;
  storageWriteRetry.signaled = false;
  const acknowledgements: IdentityPolicyPersistedRevision[] = [];
  const temporaryAdBypassAcknowledgements: TemporaryAdBypassPersistedRevision[] = [];
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
  for (const [id, change] of temporaryAdBypass) {
    if (pendingTemporaryAdBypassWrites.get(id) === change) {
      pendingTemporaryAdBypassWrites.delete(id);
    }
    temporaryAdBypassAcknowledgements.push({ id, revision: change.revision });
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
      if (pending.get(q) === change) {
        pending.delete(q);
        pendingChatQaEntryCount.current--;
      }
      chatQaAcknowledgements.push({ chatId, q, revision: change.revision });
    }
    // 空 Map 不留存，否则每个曾登记过问答的群都会在缓冲里留一项空壳。
    if (pending.size === 0) pendingChatQaWrites.delete(chatId);
  }
  for (const [chatId, change] of aiContexts) {
    if (pendingAiContextWrites.get(chatId) === change) pendingAiContextWrites.delete(chatId);
    settleAiContextPersisted(chatId, change);
  }
  if (pendingRemovalSnapshotRevision.current === removalRevision) {
    pendingRemovalSnapshotRevision.current = null;
  }
  reply({
    type: "identityStoragePersisted",
    writes: acknowledgements,
    temporaryAdBypassWrites: temporaryAdBypassAcknowledgements,
    chatStateWrites: chatStateAcknowledgements,
    chatQaWrites: chatQaAcknowledgements,
    ...(removalRevision === null ? {} : { removalSnapshotRevision: removalRevision }),
  });
  scheduleStorageCommit();
  return !rejected;
}

/** 取走拒收标记，并叠加本轮仍 dirty 的表，供统一 flush 返回精确失败领域。 */
export function pendingStorageDatabaseDomains(): readonly (
  "whitelist" | "blocklist" | "temporaryAdBypass" | "blocklistRemovalOutbox" | "chatState" | "chatQa" | "aiMemory"
)[] {
  const domains: Set<
    "whitelist" | "blocklist" | "temporaryAdBypass" | "blocklistRemovalOutbox" | "chatState" | "chatQa" | "aiMemory"
  > = new Set(rejectedStorageDomains);
  rejectedStorageDomains.clear();
  if (pendingWhitelistWrites.size > 0) domains.add("whitelist");
  if (pendingBlocklistWrites.size > 0) domains.add("blocklist");
  if (pendingTemporaryAdBypassWrites.size > 0) domains.add("temporaryAdBypass");
  if (pendingRemovalWrites.size > 0) domains.add("blocklistRemovalOutbox");
  if (pendingChatStateWrites.size > 0) domains.add("chatState");
  if (pendingChatQaWrites.size > 0) domains.add("chatQa");
  if (pendingAiContextWrites.size > 0) domains.add("aiMemory");
  return [...domains];
}

/** Worker 启动时安装事务 ACK 通道，供 30 秒 timer 复用。 */
export function configureStoragePersistenceReply(
  reply: IdentityPersistenceReply
): void {
  storagePersistenceReplyHolder.current = reply;
}

/**
 * 开合镜像重放区间。关闭时有待回执的 AI 上下文删除或即时快照、且不在重试退避期，就立即以
 * 一个事务提交区间内的全部变化；否则按批次阈值补做一次判定，未达阈值保留定时提交。
 */
export function setStorageFlushHold(active: boolean, reply: IdentityPersistenceReply): void {
  storageFlushHold.current = active;
  if (active) return;
  if (storageWriteRetry.failures === 0 && hasUrgentAiContextWrites()) {
    flushStorageDatabase(reply);
    return;
  }
  flushIfStorageFull(reply);
}
