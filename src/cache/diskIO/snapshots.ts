/** AI 记忆快照、dirty/delete 集合及其 flush timer 的唯一 owner。 */
export const aiMemoryCache: Map<number, string> = new Map();
export const dirtyChats: Set<number> = new Set();
export const deletedAiMemoryChats: Set<number> = new Set();
/** diskIOWorker 运行时按 chat 观察到的最新 revision 与操作种类。 */
export const aiMemoryRevisions: Map<number, number> = new Map();
export const aiMemoryOperations: Map<number, "upsert" | "delete"> = new Map();
export const aiMemoryFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

export function hydrateAiMemoryCache(snapshots: ReadonlyMap<number, string>): void {
  if (aiMemoryFlushState.timer !== null) clearTimeout(aiMemoryFlushState.timer);
  aiMemoryFlushState.timer = null;
  aiMemoryCache.clear();
  dirtyChats.clear();
  deletedAiMemoryChats.clear();
  aiMemoryRevisions.clear();
  aiMemoryOperations.clear();
  for (const [chatId, snapshot] of snapshots) {
    aiMemoryCache.set(chatId, snapshot);
    aiMemoryRevisions.set(chatId, 0);
    aiMemoryOperations.set(chatId, "upsert");
  }
}

export function markAiMemoryDirty(chatId: number, revision: number, snapshot: string): boolean {
  const currentRevision: number = aiMemoryRevisions.get(chatId) ?? -1;
  const currentOperation = aiMemoryOperations.get(chatId);
  if (revision < currentRevision || (revision === currentRevision && currentOperation === "delete")) return false;
  deletedAiMemoryChats.delete(chatId);
  aiMemoryCache.set(chatId, snapshot);
  aiMemoryRevisions.set(chatId, revision);
  aiMemoryOperations.set(chatId, "upsert");
  dirtyChats.add(chatId);
  return true;
}

export function markAiMemoryDeleted(chatId: number, revision: number): boolean {
  const currentRevision: number = aiMemoryRevisions.get(chatId) ?? -1;
  const currentOperation = aiMemoryOperations.get(chatId);
  if (revision < currentRevision || (revision === currentRevision && currentOperation === "upsert")) return false;
  aiMemoryCache.delete(chatId);
  dirtyChats.delete(chatId);
  aiMemoryRevisions.set(chatId, revision);
  aiMemoryOperations.set(chatId, "delete");
  deletedAiMemoryChats.add(chatId);
  return true;
}

export function resetAiMemoryCache(): void {
  if (aiMemoryFlushState.timer !== null) clearTimeout(aiMemoryFlushState.timer);
  aiMemoryFlushState.timer = null;
  aiMemoryCache.clear();
  dirtyChats.clear();
  deletedAiMemoryChats.clear();
  aiMemoryRevisions.clear();
  aiMemoryOperations.clear();
}
