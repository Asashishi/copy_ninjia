import { SNAPSHOT_FLUSH_INTERVAL_MS } from "../../consts/diskIO/snapshots";
import {
  aiMemoryCache,
  aiMemoryFlushState,
  deletedAiMemoryChats,
  dirtyChats,
  hydrateAiMemoryCache,
  markAiMemoryDeleted,
  markAiMemoryDirty,
  resetAiMemoryCache,
} from "../../cache/diskIO/snapshots";
import { flushDirtyEntries } from "./dirtyFlush";
import { deleteAiMemoryFile, recoverAiMemories, writeAiMemoryFile } from "./snapshotFiles";

function scheduleAiMemoryFlush(): void {
  if (aiMemoryFlushState.timer !== null) return;
  aiMemoryFlushState.timer = setTimeout(() => {
    aiMemoryFlushState.timer = null;
    flushAiMemorySnapshots();
  }, SNAPSHOT_FLUSH_INTERVAL_MS);
}

/** 启动恢复边界：用磁盘快照整体替换内存 owner。 */
export function hydrateAiMemorySnapshots(): Map<number, string> {
  hydrateAiMemoryCache(recoverAiMemories());
  return aiMemoryCache;
}

/** 覆盖式快照的 markDirty 边界。 */
export function markAiMemorySnapshotDirty(chatId: number, snapshot: string): void {
  markAiMemoryDirty(chatId, snapshot);
  scheduleAiMemoryFlush();
}

/** 删除立即尝试落盘；失败保留待删标记并独立重试。 */
export function deleteAiMemorySnapshot(chatId: number): void {
  markAiMemoryDeleted(chatId);
  try {
    deleteAiMemoryFile(chatId);
    deletedAiMemoryChats.delete(chatId);
  } catch (error) {
    console.error(`[diskIOWorker] failed to delete AI memory snapshot for chat ${chatId}:`, error);
    scheduleAiMemoryFlush();
  }
}

/** flush 边界：逐份写入，单份失败保留 dirty 并自动重排。 */
export function flushAiMemorySnapshots(): void {
  if (aiMemoryFlushState.timer !== null) {
    clearTimeout(aiMemoryFlushState.timer);
    aiMemoryFlushState.timer = null;
  }
  for (const chatId of deletedAiMemoryChats) {
    try {
      deleteAiMemoryFile(chatId);
      deletedAiMemoryChats.delete(chatId);
    } catch (error) {
      console.error(`[diskIOWorker] failed to delete AI memory snapshot for chat ${chatId}:`, error);
    }
  }
  flushDirtyEntries(
    dirtyChats,
    aiMemoryCache,
    writeAiMemoryFile,
    (chatId: number) => `[diskIOWorker] failed to write AI memory snapshot for chat ${chatId}:`
  );
  if (deletedAiMemoryChats.size > 0 || dirtyChats.size > 0) scheduleAiMemoryFlush();
}

/** reset 边界：停止 timer 并清空恢复态、dirty 与待删集合。 */
export function resetAiMemoryFiles(): void {
  resetAiMemoryCache();
}
