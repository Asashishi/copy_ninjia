import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../../consts/diskIO/snapshots";
import {
  aiMemoryCache,
  aiMemoryDeletePersistedNotifier,
  aiMemoryFlushState,
  aiMemoryRevisions,
  deletedAiMemoryChats,
  dirtyChats,
  hydrateAiMemoryCache,
  markAiMemoryDeleted,
  markAiMemoryDirty,
  resetAiMemoryCache,
} from "../../cache/diskIO/snapshots";
import { flushDirtyEntries } from "./dirtyFlush";
import { deleteAiMemoryFile, recoverAiMemories, writeAiMemoryFile } from "./snapshotFiles";
import type { AiMemoryDeletedPersistedReply } from "../../types/diskIO";
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

function scheduleAiMemoryFlush(): void {
  if (aiMemoryFlushState.timer !== null) return;
  aiMemoryFlushState.timer = setTimeout(() => {
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

/** 覆盖式快照的 markDirty 边界。 */
export function markAiMemorySnapshotDirty(chatId: number, revision: number, snapshot: string): void {
  if (!markAiMemoryDirty(chatId, revision, snapshot)) return;
  scheduleAiMemoryFlush();
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
  flushDirtyEntries({
    dirty: dirtyChats,
    cache: aiMemoryCache,
    write: (chatId: number, snapshot: string): void => { files.write(chatId, snapshot); },
    describeFailure: (chatId: number) => `[diskIOWorker] failed to write AI memory snapshot for chat ${chatId}:`,
  });
  if (deletedAiMemoryChats.size > 0 || dirtyChats.size > 0) scheduleAiMemoryFlush();
  return deletedAiMemoryChats.size === 0 && dirtyChats.size === 0;
}

/** reset 边界：停止 timer 并清空恢复态、dirty 与待删集合。 */
export function resetAiMemoryFiles(): void {
  resetAiMemoryCache();
}
