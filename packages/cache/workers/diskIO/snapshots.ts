/** owner: workers/diskIO。AI 记忆的 revision 水位线与回执出口；快照最终值排入共享 SQLite
 * 事务缓冲（cache/workers/diskIO/storageDatabase.ts 的 pendingAiContextWrites），由
 * aiMemoryStorage.ts 按 revision 接管。
 */

import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
} from "../../../types/diskIO/replies";

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
/**
 * 欠一次即时写入回执的群。提交前被更新 revision 覆盖时，提交最新快照后以最新
 * revision 回执，同样证明这次 purge 后已有新记忆 durable。
 *
 * 填充：purge 之后要求即时写入的首份新快照入队时登记。清理：共享事务提交后的回执结算
 * （storageDatabase/aiContext.ts 的 settleAiContextPersisted）、markAiMemoryDeleted
 * 与 resetAiMemoryCache。Worker 崩溃重建：不重建——它只表达「本进程这一刻还欠
 * 一次即时写」，新实例没有这笔欠账。容量：同时处于该状态的群数，上界为受管群数。
 */
export const aiMemoryImmediateChats: Set<number> = new Set();

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

/** 启动恢复时按磁盘现存快照整体重建水位线，并清除旧 revision 与即时回执欠账。 */
export function hydrateAiMemoryCache(snapshots: ReadonlyMap<number, string>): void {
  resetAiMemoryCache();
  for (const chatId of snapshots.keys()) {
    aiMemoryRevisions.set(chatId, 0);
    aiMemoryOperations.set(chatId, "upsert");
  }
}

/** 以 revision 判定一份 upsert；拒绝迟到更新，接受时推进水位线。 */
export function markAiMemoryDirty(chatId: number, revision: number): boolean {
  const currentRevision: number = aiMemoryRevisions.get(chatId) ?? -1;
  const currentOperation: "delete" | "upsert" | undefined = aiMemoryOperations.get(chatId);
  if (revision < currentRevision || (revision === currentRevision && currentOperation === "delete")) return false;
  aiMemoryRevisions.set(chatId, revision);
  aiMemoryOperations.set(chatId, "upsert");
  return true;
}

/** 以 revision 判定一份删除；接受时推进水位线并撤销该群尚未结算的即时写入回执。 */
export function markAiMemoryDeleted(chatId: number, revision: number): boolean {
  const currentRevision: number = aiMemoryRevisions.get(chatId) ?? -1;
  const currentOperation: "delete" | "upsert" | undefined = aiMemoryOperations.get(chatId);
  if (revision < currentRevision || (revision === currentRevision && currentOperation === "upsert")) return false;
  aiMemoryRevisions.set(chatId, revision);
  aiMemoryOperations.set(chatId, "delete");
  aiMemoryImmediateChats.delete(chatId);
  return true;
}

/**
 * 丢弃某群的 revision 水位线；只由 forgetAiMemory 消息触发。
 *
 * 调用前提由主线程负责：该群已 durable 删除、AI Worker 失效，且没有在途快照、墓碑与
 * waiter（见 aiChat/memoryMirror.ts 的 forgetAiMemoryRevisionCounter）。没有
 * 这个前提就不能删水位线——它正是用来挡迟到 upsert 的。
 *
 * 只动这两张水位线表：共享事务缓冲里的上下文最终值有自己的生命周期，
 * 「忘掉 revision 序列」不表达「删除上下文」。
 */
export function forgetAiMemoryChat(chatId: number): void {
  aiMemoryRevisions.delete(chatId);
  aiMemoryOperations.delete(chatId);
}

/** Worker 停止或测试隔离时清空全部 AI 记忆水位线与即时回执欠账。 */
export function resetAiMemoryCache(): void {
  aiMemoryRevisions.clear();
  aiMemoryOperations.clear();
  aiMemoryImmediateChats.clear();
}
