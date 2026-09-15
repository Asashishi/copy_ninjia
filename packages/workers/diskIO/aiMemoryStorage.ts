import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../../consts/diskIO/snapshots";
import {
  aiMemoryCache,
  aiMemoryDeletePersistedNotifier,
  aiMemoryFlushState,
  aiMemoryImmediateRevisions,
  aiMemoryPersistedNotifier,
  aiMemoryRevisions,
  deletedAiMemoryChats,
  dirtyChats,
  hydrateAiMemoryCache,
  markAiMemoryDeleted,
  markAiMemoryDirty,
} from "../../cache/workers/diskIO/snapshots";
import {
  deleteAiContext,
  writeAiContext,
} from "./storageDatabase/aiContext";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
} from "../../types/diskIO/replies";
import type { AiMemorySnapshotStorageDependencies } from "../../types/diskIO/snapshotOwners";

/** Disk I/O owner 的只读 SQLite 写入与删除句柄；整个 Worker 生命周期保持不变。 */
const AI_MEMORY_STORAGE_DEPENDENCIES: Readonly<AiMemorySnapshotStorageDependencies> = {
  write: writeAiContext,
  delete: deleteAiContext,
};

/** Worker 启动时注入唯一回执出口；测试可替换为确定性收集器。 */
export function configureAiMemoryDeletePersistedReply(
  notify: (reply: AiMemoryDeletedPersistedReply) => void
): void {
  aiMemoryDeletePersistedNotifier.current = notify;
}

/** Worker 启动时注入 purge 后首份新快照的 durable 回执出口。 */
export function configureAiMemoryPersistedReply(
  notify: (reply: AiMemoryPersistedReply) => void
): void {
  aiMemoryPersistedNotifier.current = notify;
}

function scheduleAiMemoryFlush(): void {
  if (aiMemoryFlushState.timer !== null) return;
  aiMemoryFlushState.timer = setTimeout((): void => {
    aiMemoryFlushState.timer = null;
    flushAiMemorySnapshots();
  }, SNAPSHOT_FLUSH_INTERVAL_MS);
  aiMemoryFlushState.timer.unref();
}

/** 跨域启动第二阶段：全部领域 inspect 成功后整体发布到 owner 缓存。 */
export function adoptAiMemorySnapshots(
  snapshots: ReadonlyMap<number, string>
): Map<number, string> {
  hydrateAiMemoryCache(snapshots);
  return aiMemoryCache;
}

export interface MarkAiMemorySnapshotDirtyParams {
  chatId: number;
  revision: number;
  snapshot: string;
  persistImmediately?: boolean;
  storage?: AiMemorySnapshotStorageDependencies;
}

/** 写入单群最新快照；即时 revision durable 后在删除 dirty 标记的同一边界回执。 */
function flushAiMemorySnapshot(
  chatId: number,
  storage: AiMemorySnapshotStorageDependencies
): boolean {
  const snapshot: string | undefined = aiMemoryCache.get(chatId);
  if (snapshot === undefined) {
    dirtyChats.delete(chatId);
    aiMemoryImmediateRevisions.delete(chatId);
    return true;
  }
  try {
    storage.write(chatId, snapshot);
    dirtyChats.delete(chatId);
    const immediateRevision: number | undefined = aiMemoryImmediateRevisions.get(chatId);
    if (immediateRevision !== undefined) {
      aiMemoryImmediateRevisions.delete(chatId);
      aiMemoryPersistedNotifier.current({
        type: "aiMemoryPersisted",
        chatId,
        revision: aiMemoryRevisions.get(chatId) ?? immediateRevision,
      });
    }
    return true;
  } catch (error: unknown) {
    console.error(`[diskIOWorker] failed to write AI memory snapshot for chat ${chatId}:`, error);
    return false;
  }
}

/**
 * 覆盖式快照的 markDirty 边界。purge 后首份新快照同步尝试写盘；失败仍保留
 * dirty 与即时 revision，由普通重试 timer 继续处理，不会退回静默丢失。
 */
export function markAiMemorySnapshotDirty({
  chatId,
  revision,
  snapshot,
  persistImmediately = false,
  storage = AI_MEMORY_STORAGE_DEPENDENCIES,
}: MarkAiMemorySnapshotDirtyParams): void {
  if (!markAiMemoryDirty(chatId, revision, snapshot)) return;
  if (!persistImmediately) {
    scheduleAiMemoryFlush();
    return;
  }
  aiMemoryImmediateRevisions.set(chatId, revision);
  if (!flushAiMemorySnapshot(chatId, storage)) scheduleAiMemoryFlush();
}

/** 删除立即尝试落盘；失败保留待删标记并独立重试。 */
export function deleteAiMemorySnapshot(
  chatId: number,
  revision: number,
  storage: AiMemorySnapshotStorageDependencies = AI_MEMORY_STORAGE_DEPENDENCIES
): void {
  if (!markAiMemoryDeleted(chatId, revision)) {
    aiMemoryDeletePersistedNotifier.current({ type: "aiMemoryDeletedPersisted", chatId, revision });
    return;
  }
  try {
    storage.delete(chatId);
    deletedAiMemoryChats.delete(chatId);
    aiMemoryDeletePersistedNotifier.current({ type: "aiMemoryDeletedPersisted", chatId, revision });
  } catch (error: unknown) {
    console.error(`[diskIOWorker] failed to delete AI memory snapshot for chat ${chatId}:`, error);
    scheduleAiMemoryFlush();
  }
}

/** flush 边界：逐份写入，单份失败保留 dirty 并自动重排。 */
export function flushAiMemorySnapshots(
  storage: AiMemorySnapshotStorageDependencies = AI_MEMORY_STORAGE_DEPENDENCIES
): boolean {
  if (aiMemoryFlushState.timer !== null) {
    clearTimeout(aiMemoryFlushState.timer);
    aiMemoryFlushState.timer = null;
  }
  for (const chatId of deletedAiMemoryChats) {
    try {
      storage.delete(chatId);
      deletedAiMemoryChats.delete(chatId);
      aiMemoryDeletePersistedNotifier.current({
        type: "aiMemoryDeletedPersisted",
        chatId,
        revision: aiMemoryRevisions.get(chatId)!,
      });
    } catch (error: unknown) {
      console.error(`[diskIOWorker] failed to delete AI memory snapshot for chat ${chatId}:`, error);
    }
  }
  for (const chatId of dirtyChats) flushAiMemorySnapshot(chatId, storage);
  if (deletedAiMemoryChats.size > 0 || dirtyChats.size > 0) scheduleAiMemoryFlush();
  return deletedAiMemoryChats.size === 0 && dirtyChats.size === 0;
}
