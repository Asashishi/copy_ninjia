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
  resetAiMemoryCache,
} from "../../cache/diskIO/snapshots";
import { deleteAiMemoryFile, recoverAiMemories, writeAiMemoryFile } from "./snapshotFiles";
import type { AiMemoryDeletedPersistedReply, AiMemoryPersistedReply } from "../../types/diskIO";
import type { AiMemorySnapshotFileDependencies } from "../../types/diskIO/snapshotOwners";

const AI_MEMORY_FILE_DEPENDENCIES: AiMemorySnapshotFileDependencies = {
  recover: recoverAiMemories,
  write: writeAiMemoryFile,
  delete: deleteAiMemoryFile,
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
}

/** 启动恢复边界：用磁盘快照整体替换内存 owner。 */
export function hydrateAiMemorySnapshots(
  files: AiMemorySnapshotFileDependencies = AI_MEMORY_FILE_DEPENDENCIES
): Map<number, string> {
  hydrateAiMemoryCache(files.recover());
  return aiMemoryCache;
}

export interface MarkAiMemorySnapshotDirtyParams {
  chatId: number;
  revision: number;
  snapshot: string;
  persistImmediately?: boolean;
  files?: AiMemorySnapshotFileDependencies;
}

/** 写入单群最新快照；即时 revision durable 后在删除 dirty 标记的同一边界回执。 */
function flushAiMemorySnapshot(
  chatId: number,
  files: AiMemorySnapshotFileDependencies
): boolean {
  const snapshot: string | undefined = aiMemoryCache.get(chatId);
  if (snapshot === undefined) {
    dirtyChats.delete(chatId);
    aiMemoryImmediateRevisions.delete(chatId);
    return true;
  }
  try {
    files.write(chatId, snapshot);
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
  files = AI_MEMORY_FILE_DEPENDENCIES,
}: MarkAiMemorySnapshotDirtyParams): void {
  if (!markAiMemoryDirty(chatId, revision, snapshot)) return;
  if (!persistImmediately) {
    scheduleAiMemoryFlush();
    return;
  }
  aiMemoryImmediateRevisions.set(chatId, revision);
  if (!flushAiMemorySnapshot(chatId, files)) scheduleAiMemoryFlush();
}

/** 删除立即尝试落盘；失败保留待删标记并独立重试。 */
export function deleteAiMemorySnapshot(
  chatId: number,
  revision: number,
  files: AiMemorySnapshotFileDependencies = AI_MEMORY_FILE_DEPENDENCIES
): void {
  if (!markAiMemoryDeleted(chatId, revision)) {
    aiMemoryDeletePersistedNotifier.current({ type: "aiMemoryDeletedPersisted", chatId, revision });
    return;
  }
  try {
    files.delete(chatId);
    deletedAiMemoryChats.delete(chatId);
    aiMemoryDeletePersistedNotifier.current({ type: "aiMemoryDeletedPersisted", chatId, revision });
  } catch (error: unknown) {
    console.error(`[diskIOWorker] failed to delete AI memory snapshot for chat ${chatId}:`, error);
    scheduleAiMemoryFlush();
  }
}

/** flush 边界：逐份写入，单份失败保留 dirty 并自动重排。 */
export function flushAiMemorySnapshots(
  files: AiMemorySnapshotFileDependencies = AI_MEMORY_FILE_DEPENDENCIES
): boolean {
  if (aiMemoryFlushState.timer !== null) {
    clearTimeout(aiMemoryFlushState.timer);
    aiMemoryFlushState.timer = null;
  }
  for (const chatId of deletedAiMemoryChats) {
    try {
      files.delete(chatId);
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
  for (const chatId of dirtyChats) flushAiMemorySnapshot(chatId, files);
  if (deletedAiMemoryChats.size > 0 || dirtyChats.size > 0) scheduleAiMemoryFlush();
  return deletedAiMemoryChats.size === 0 && dirtyChats.size === 0;
}

/** reset 边界：停止 timer 并清空恢复态、dirty 与待删集合。 */
export function resetAiMemoryFiles(): void {
  resetAiMemoryCache();
}
