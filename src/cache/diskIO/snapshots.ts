import type { AiMemoryDeletedPersistedReply } from "../../types/diskIO";

/**
 * AI 记忆快照落盘（src/workers/diskIO/aiMemoryFiles.ts）的内存状态；同目录
 * 下的 snapshotFiles.ts 只是无状态的读写辅助函数集合，不持有任何状态。
 */

/** AI 记忆快照、dirty/delete 集合及其 flush timer 的唯一 owner。 */
export const aiMemoryCache: Map<number, string> = new Map();
/** 需要覆盖写入的群；成功 flush、删除接管或 reset 时清除。 */
export const dirtyChats: Set<number> = new Set();
/** 需要 durable unlink 的群；删除回执或 reset 时清除。 */
export const deletedAiMemoryChats: Set<number> = new Set();
/** diskIOWorker 运行时按 chat 观察到的最新 revision 与操作种类。 */
export const aiMemoryRevisions: Map<number, number> = new Map();
/** 每群最新 revision 对应 upsert/delete；hydrate 或 reset 时重建。 */
export const aiMemoryOperations: Map<number, "upsert" | "delete"> = new Map();
/** AI 记忆批量刷盘 timer；首次 dirty 创建，flush/reset 时清除。 */
export const aiMemoryFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };

/**
 * AI 快照删除 durable 后的唯一回执出口。diskIOWorker 启动时配置，Worker
 * isolate 销毁时自然清除；测试未配置时使用 no-op，容量固定为一个回调。
 */
export const aiMemoryDeletePersistedNotifier: {
  current: (reply: AiMemoryDeletedPersistedReply) => void;
} = {
  current: () => {
    // Worker 入口会在处理消息前配置；文件 owner 单测不需要回执出口。
  },
};

/** 启动恢复时整体替换镜像并清除旧 dirty、待删、revision 与 timer。 */
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

/** 以 revision 判定并接管一份 upsert；拒绝迟到更新，接受时标记待刷。 */
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

/** 以 revision 判定并接管一份删除；接受时移除镜像并登记待 unlink。 */
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

/** Worker 停止或测试隔离时取消 timer 并清空全部 AI 快照运行态。 */
export function resetAiMemoryCache(): void {
  if (aiMemoryFlushState.timer !== null) clearTimeout(aiMemoryFlushState.timer);
  aiMemoryFlushState.timer = null;
  aiMemoryCache.clear();
  dirtyChats.clear();
  deletedAiMemoryChats.clear();
  aiMemoryRevisions.clear();
  aiMemoryOperations.clear();
}
