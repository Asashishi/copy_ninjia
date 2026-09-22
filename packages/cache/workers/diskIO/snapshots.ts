import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
} from "../../../types/diskIO/replies";

/** owner: workers/diskIO。AI 上下文缓存由 aiMemoryStorage.ts 写入 SQLite。 */

/**
 * AI 记忆快照、dirty/delete 集合及其 flush timer 的唯一 owner。
 *
 * 填充：hydrate 按磁盘现存快照整体重建，此后每次 markAiMemoryDirty 覆盖一群。
 * 清理：markAiMemoryDeleted（接管一次删除）、hydrateAiMemoryCache、
 * resetAiMemoryCache。Worker 崩溃重建：load 后的 hydrate 从 SQLite 重读。
 * 容量：每个受管群一份快照，上界 STATE_MANAGED_CHAT_LIMIT（见 consts/storage.ts）。
 */
export const aiMemoryCache: Map<number, string> = new Map();
/**
 * 需要覆盖写入的群；成功 flush、删除接管或 reset 时清除。
 * 容量：aiMemoryCache 的子集，同样以受管群数为上界。
 */
export const dirtyChats: Set<number> = new Set();
/**
 * 需要 durable 清除 ai_context 的群；删除回执或 reset 时清除。
 * 容量：受管群数级别；清空事务达到 durable 边界后逐个移出。
 */
export const deletedAiMemoryChats: Set<number> = new Set();
/**
 * diskIOWorker 运行时按 chat 观察到的最新 revision（迟到消息的水位线）。
 *
 * 填充：hydrate 时按已存在的快照置 0，此后每次接受 upsert/delete 时更新。
 * 清理：`forgetAiMemoryChat`（主线程 teardown 后确认该群再无在途操作时发来的
 * forgetAiMemory 消息）、`hydrateAiMemoryCache`、`resetAiMemoryCache`。
 * **删除受理本身不清**——那会让一条早发的旧 revision 复活刚删掉的记忆。
 * Worker 崩溃重建：由 load 后的 hydrate 按磁盘现存快照整体重建；主线程的
 * tombstone 与最新快照另由 onDiskIORespawn 重放。
 * 容量：活跃 chat 数级别，并由 forgetAiMemoryChat 随 teardown 回收；没有这条
 * 回收路径时它会按「进程历史上出现过的 chat 数」单调增长。
 */
export const aiMemoryRevisions: Map<number, number> = new Map();
/**
 * 每群最新 revision 对应的操作种类，用来给同 revision 的 upsert/delete 定序。
 * 填充、清理、重建与容量策略同 aiMemoryRevisions，两张表始终成对增删。
 */
export const aiMemoryOperations: Map<number, "upsert" | "delete"> = new Map();
/** AI 记忆批量刷盘 timer；首次 dirty 创建，flush/reset 时清除。 */
export const aiMemoryFlushState: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
/**
 * 要求即时写入的最早 revision；若写盘前被更新 revision 覆盖，写入最新快照
 * 后以最新 revision 回执，同样证明这次 purge 后已有新记忆 durable。
 *
 * 填充：purge 之后的首份新快照登记一次。清理：写盘回执、markAiMemoryDeleted
 * 与 resetAiMemoryCache。Worker 崩溃重建：不重建——它只表达「本进程这一刻还欠
 * 一次即时写」，新实例没有这笔欠账。容量：同时处于该状态的群数，上界为受管群数。
 */
export const aiMemoryImmediateRevisions: Map<number, number> = new Map();

/**
 * AI 快照删除 durable 后的唯一回执出口。diskIOWorker 启动时配置，Worker
 * isolate 销毁时自然清除；测试未配置时使用 no-op，容量固定为一个回调。
 */
export const aiMemoryDeletePersistedNotifier: {
  current: (reply: AiMemoryDeletedPersistedReply) => void;
} = {
  current: (): void => {
    // Worker 入口会在处理消息前配置；快照 owner 单测不需要回执出口。
  },
};

/** purge 后首份新快照 durable 后的唯一回执出口。 */
export const aiMemoryPersistedNotifier: {
  current: (reply: AiMemoryPersistedReply) => void;
} = {
  current: (): void => {
    // Worker 入口会在处理消息前配置；快照 owner 单测不需要回执出口。
  },
};

/** 启动恢复时整体替换镜像并清除旧 dirty、待删、revision 与 timer。 */
export function hydrateAiMemoryCache(snapshots: ReadonlyMap<number, string>): void {
  resetAiMemoryCache();
  for (const [chatId, snapshot] of snapshots) {
    aiMemoryCache.set(chatId, snapshot);
    aiMemoryRevisions.set(chatId, 0);
    aiMemoryOperations.set(chatId, "upsert");
  }
}

/** 以 revision 判定并接管一份 upsert；拒绝迟到更新，接受时标记待刷。 */
export function markAiMemoryDirty(chatId: number, revision: number, snapshot: string): boolean {
  const currentRevision: number = aiMemoryRevisions.get(chatId) ?? -1;
  const currentOperation: "delete" | "upsert" | undefined = aiMemoryOperations.get(chatId);
  if (revision < currentRevision || (revision === currentRevision && currentOperation === "delete")) return false;
  deletedAiMemoryChats.delete(chatId);
  aiMemoryCache.set(chatId, snapshot);
  aiMemoryRevisions.set(chatId, revision);
  aiMemoryOperations.set(chatId, "upsert");
  dirtyChats.add(chatId);
  return true;
}

/** 以 revision 判定并接管一份删除；接受时移除镜像并登记待清除上下文。 */
export function markAiMemoryDeleted(chatId: number, revision: number): boolean {
  const currentRevision: number = aiMemoryRevisions.get(chatId) ?? -1;
  const currentOperation: "delete" | "upsert" | undefined = aiMemoryOperations.get(chatId);
  if (revision < currentRevision || (revision === currentRevision && currentOperation === "upsert")) return false;
  aiMemoryCache.delete(chatId);
  dirtyChats.delete(chatId);
  aiMemoryRevisions.set(chatId, revision);
  aiMemoryOperations.set(chatId, "delete");
  deletedAiMemoryChats.add(chatId);
  aiMemoryImmediateRevisions.delete(chatId);
  return true;
}

/**
 * 丢弃某群的 revision 水位线；只由 forgetAiMemory 消息触发。
 *
 * 调用前提由主线程负责：该群已 durable 删除、AI Worker 失效，且没有在途快照、墓碑与
 * waiter（见 aiChat/memoryMirror.ts 的 forgetAiMemoryRevisionCounter）。没有
 * 这个前提就不能删水位线——它正是用来挡迟到 upsert 的。
 *
 * 只动这两张水位线表：快照本体与待清除上下文集合各有自己的生命周期，
 * 「忘掉 revision 序列」不表达「删除上下文」。
 */
export function forgetAiMemoryChat(chatId: number): void {
  aiMemoryRevisions.delete(chatId);
  aiMemoryOperations.delete(chatId);
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
  aiMemoryImmediateRevisions.clear();
}
