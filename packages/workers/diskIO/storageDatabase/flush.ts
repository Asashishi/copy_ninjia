import { STORAGE_DATABASE_DOMAINS, STORAGE_WRITE_MAX_FAILURES } from "../../../consts/diskIO/business";
import {
  resetStoragePendingBudgets,
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
  storageDatabaseClosed,
  storageDatabaseWriters,
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
import {
  commitStorageDatabaseChanges,
  prepareStorageDatabaseWriter,
} from "../../../database/interact/transaction";
import type {
  ChatQaPersistedRevision,
  ChatStatePersistedRevision,
  DiskIODomain,
  IdentityPersistenceReply,
  IdentityPolicyPersistedRevision,
  StorageDatabaseDomain,
  TemporaryAdBypassPersistedRevision,
} from "../../../types/diskIO/replies";
import type { StorageDatabase, StorageDatabaseWriter } from "../../../types/storageDatabase";
import { hasUrgentAiContextWrites, settleAiContextPersisted } from "./aiContext";
import { requireStorageDatabase } from "./context";

/** 当前连接的预编译写语句；每条连接首次提交时建一次。 */
function storageDatabaseWriter(): StorageDatabaseWriter {
  const database: StorageDatabase = requireStorageDatabase();
  const existing: StorageDatabaseWriter | undefined = storageDatabaseWriters.get(database);
  if (existing !== undefined) return existing;
  const writer: StorageDatabaseWriter = prepareStorageDatabaseWriter(database);
  storageDatabaseWriters.set(database, writer);
  return writer;
}

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
 * 为已排入缓冲的变化建立固定截止 timer；没有待写变化、已有 timer、已停止自动提交或
 * 停机已关库时不重复装。AI 上下文的普通快照、事务失败后的退避与重放区间都走这条定时提交。
 */
export function scheduleStorageCommit(): void {
  if (
    !hasPendingStorageWrites() ||
    storageWriteFlushTimer.current !== null ||
    storageWriteRetry.signaled ||
    storageDatabaseClosed.current
  ) return;
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
    // 事务失败由 flushStorageDatabase 自己记日志并按退避重排。
    flushStorageDatabase(reply);
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
    flushStorageDatabase(reply);
    return;
  }
  scheduleStorageCommit();
}

/**
 * 当前各表与 AI 上下文的待写值在一个显式事务中提交；成功后才清缓冲并回 ACK，AI 上下文
 * 另按 AI 记忆协议发出删除与即时写入回执。事务失败时记日志、累计失败并按退避重排提交，
 * 结束时都会为剩余变化重排 timer。拒收标记不影响返回值，由统一 flush 经
 * collectStorageDatabaseFailures 按领域回报。停机已关库（storageDatabaseClosed）时不再提交，
 * 有待写值即返回 false，不计入连续失败。
 * @returns true 表示本轮全部变化已 durable 或本来无变化。
 */
export function flushStorageDatabase(reply: IdentityPersistenceReply): boolean {
  // outbox 快照 revision 只与待写行一同挂起（没有行变化时当场确认，见 pendingRemoval.ts），
  // 待写缓冲只在提交成功或整表复位时清空，两处都同时清掉 revision：无待写即无待确认的 revision。
  if (!hasPendingStorageWrites()) return true;
  if (storageDatabaseClosed.current) return false;
  if (storageWriteFlushTimer.current !== null) {
    clearTimeout(storageWriteFlushTimer.current);
    storageWriteFlushTimer.current = null;
  }
  // Bun SQLite 事务同步执行；提交、清空与 ACK 回调之间不让出本 isolate，因此提交的
  // 就是各缓冲的全部内容，成功后整表结算清空。
  const removalRevision: number | null = pendingRemovalSnapshotRevision.current;
  try {
    commitStorageDatabaseChanges(storageDatabaseWriter(), {
      whitelist: pendingWhitelistWrites,
      blocklist: pendingBlocklistWrites,
      temporaryAdBypass: pendingTemporaryAdBypassWrites,
      removals: pendingRemovalWrites,
      chatStates: pendingChatStateWrites,
      chatQa: pendingChatQaWrites,
      aiContexts: pendingAiContextWrites,
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
  resetStoragePendingBudgets();
  storageWriteRetry.failures = 0;
  storageWriteRetry.retryAt = 0;
  storageWriteRetry.signaled = false;
  const acknowledgements: IdentityPolicyPersistedRevision[] = [];
  const temporaryAdBypassAcknowledgements: TemporaryAdBypassPersistedRevision[] = [];
  const chatStateAcknowledgements: ChatStatePersistedRevision[] = [];
  const chatQaAcknowledgements: ChatQaPersistedRevision[] = [];
  for (const [id, change] of pendingWhitelistWrites) {
    acknowledgements.push({ table: "whitelist", id, revision: change.revision });
  }
  pendingWhitelistWrites.clear();
  for (const [id, change] of pendingBlocklistWrites) {
    acknowledgements.push({ table: "blocklist", id, revision: change.revision });
  }
  pendingBlocklistWrites.clear();
  for (const [id, change] of pendingTemporaryAdBypassWrites) {
    temporaryAdBypassAcknowledgements.push({ id, revision: change.revision });
  }
  pendingTemporaryAdBypassWrites.clear();
  pendingRemovalWrites.clear();
  for (const [chatId, change] of pendingChatStateWrites) {
    chatStateAcknowledgements.push({ chatId, revision: change.revision });
  }
  pendingChatStateWrites.clear();
  for (const [chatId, questions] of pendingChatQaWrites) {
    for (const [q, change] of questions) {
      chatQaAcknowledgements.push({ chatId, q, revision: change.revision });
    }
    pendingChatQaEntryCount.current -= questions.size;
  }
  pendingChatQaWrites.clear();
  for (const [chatId, change] of pendingAiContextWrites) {
    settleAiContextPersisted(chatId, change);
  }
  pendingAiContextWrites.clear();
  pendingRemovalSnapshotRevision.current = null;
  reply({
    type: "identityStoragePersisted",
    writes: acknowledgements,
    temporaryAdBypassWrites: temporaryAdBypassAcknowledgements,
    chatStateWrites: chatStateAcknowledgements,
    chatQaWrites: chatQaAcknowledgements,
    ...(removalRevision === null ? {} : { removalSnapshotRevision: removalRevision }),
  });
  scheduleStorageCommit();
  return true;
}

/** 该领域在本轮 flush 后是否失败：仍有未提交的值，或取走了它的拒收标记。 */
function takeStorageDomainFailure(domain: StorageDatabaseDomain, dirty: boolean): boolean {
  return rejectedStorageDomains.delete(domain) || dirty;
}

/**
 * 在 flushStorageDatabase 之后调用，把共享 SQLite 的失败领域追加进统一 flush 的回执。
 * @param scope 单领域屏障只取走并回报该领域；null 表示 all/business，取走全部拒收标记
 *   并回报每个仍 dirty 或被拒收的领域。
 */
export function collectStorageDatabaseFailures(
  scope: StorageDatabaseDomain | null,
  failedDomains: DiskIODomain[]
): void {
  if (scope !== null) {
    if (takeStorageDomainFailure(scope, isStorageDomainDirty(scope))) failedDomains.push(scope);
    return;
  }
  for (const domain of STORAGE_DATABASE_DOMAINS) {
    if (takeStorageDomainFailure(domain, isStorageDomainDirty(domain))) failedDomains.push(domain);
  }
}

/** 该领域的写缓冲里是否还有未提交的最终值。 */
function isStorageDomainDirty(domain: StorageDatabaseDomain): boolean {
  switch (domain) {
    case "whitelist": return pendingWhitelistWrites.size > 0;
    case "blocklist": return pendingBlocklistWrites.size > 0;
    case "temporaryAdBypass": return pendingTemporaryAdBypassWrites.size > 0;
    case "blocklistRemovalOutbox": return pendingRemovalWrites.size > 0;
    case "chatState": return pendingChatStateWrites.size > 0;
    case "chatQa": return pendingChatQaWrites.size > 0;
    case "aiMemory": return pendingAiContextWrites.size > 0;
  }
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
