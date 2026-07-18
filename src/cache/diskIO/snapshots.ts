/** AI 记忆快照、dirty/delete 集合及其 flush timer 的唯一 owner。 */
export const aiMemoryCache: Map<number, string> = new Map();
export const dirtyChats: Set<number> = new Set();
export const deletedAiMemoryChats: Set<number> = new Set();
export const aiMemoryFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

export function hydrateAiMemoryCache(snapshots: ReadonlyMap<number, string>): void {
  if (aiMemoryFlushState.timer !== null) clearTimeout(aiMemoryFlushState.timer);
  aiMemoryFlushState.timer = null;
  aiMemoryCache.clear();
  dirtyChats.clear();
  deletedAiMemoryChats.clear();
  for (const [chatId, snapshot] of snapshots) aiMemoryCache.set(chatId, snapshot);
}

export function markAiMemoryDirty(chatId: number, snapshot: string): void {
  deletedAiMemoryChats.delete(chatId);
  aiMemoryCache.set(chatId, snapshot);
  dirtyChats.add(chatId);
}

export function markAiMemoryDeleted(chatId: number): void {
  aiMemoryCache.delete(chatId);
  dirtyChats.delete(chatId);
  deletedAiMemoryChats.add(chatId);
}

export function resetAiMemoryCache(): void {
  if (aiMemoryFlushState.timer !== null) clearTimeout(aiMemoryFlushState.timer);
  aiMemoryFlushState.timer = null;
  aiMemoryCache.clear();
  dirtyChats.clear();
  deletedAiMemoryChats.clear();
}
