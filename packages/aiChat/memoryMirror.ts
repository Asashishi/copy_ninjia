import {
  onAiMemoryDeletedPersisted,
  onAiMemoryPersisted,
  onDiskIORespawn,
  postDiskIO,
} from "../ai/persistence";
import {
  aiMemoryDeleteWaiters,
  aiMemoryRevisionCounters,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  pendingAiMemoryDeletes,
  postPurgeAiMemoryPersistRevisions,
} from "../cache/aiChat";
import { AI_MEMORY_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import type { AiMemoryDeleteWaiter } from "../types/aiChat/waiters";
import type { AiMemoryDeletedPersistedReply, AiMemoryPersistedReply } from "../types/diskIO";

/**
 * AI 记忆的主线程镜像侧（owner 是 packages/aiChat/index.ts）：按 chat 单调递增的
 * revision、待确认删除 tombstone、删除回执 waiter，以及 Disk I/O Worker 重建
 * 后的镜像重放。
 *
 * 这套状态与 aiChat/index.ts 里的 Worker 监督相互独立：aiChatWorker 崩溃靠
 * latestAiMemories 重放 hydrate（在 aiChat/index.ts 的 onRespawn 里），diskIOWorker
 * 崩溃靠本文件的 onDiskIORespawn 重放 tombstone 与最新快照。只有 durable 删除
 * 回执能释放 tombstone。
 * @see ../../docs/04-invariants.md
 */

/** 取该群下一个记忆 revision；镜像与 tombstone 都以它判定新旧。 */
export function nextAiMemoryRevision(chatId: number): number {
  const revision: number = (aiMemoryRevisionCounters.get(chatId) ?? 0) + 1;
  aiMemoryRevisionCounters.set(chatId, revision);
  return revision;
}

function removeDeleteWaiter(chatId: number, waiter: AiMemoryDeleteWaiter): void {
  const waiters: AiMemoryDeleteWaiter[] | undefined = aiMemoryDeleteWaiters.get(chatId);
  if (!waiters) return;
  const index: number = waiters.indexOf(waiter);
  if (index >= 0) waiters.splice(index, 1);
  if (waiters.length === 0) aiMemoryDeleteWaiters.delete(chatId);
}

function waitForAiMemoryDelete(chatId: number, revision: number): Promise<void> {
  return new Promise((resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: unknown) => void): void => {
    const waiter: AiMemoryDeleteWaiter = {
      revision,
      resolve,
      reject,
      timer: setTimeout((): void => {
        removeDeleteWaiter(chatId, waiter);
        reject(new Error(
          `AI memory deletion for chat ${chatId} revision ${revision} timed out after ${AI_MEMORY_FLUSH_TIMEOUT_MS}ms.`
        ));
      }, AI_MEMORY_FLUSH_TIMEOUT_MS),
    };
    const waiters: AiMemoryDeleteWaiter[] = aiMemoryDeleteWaiters.get(chatId) ?? [];
    waiters.push(waiter);
    aiMemoryDeleteWaiters.set(chatId, waiters);
  });
}

/** 建立/重放最新墓碑；wait=true 用于命令与 teardown 的 update durability barrier。 */
export function requestAiMemoryDelete(chatId: number, wait: true): Promise<void>;
export function requestAiMemoryDelete(chatId: number, wait: false): undefined;
export function requestAiMemoryDelete(chatId: number, wait: boolean): Promise<void> | undefined {
  // 新一轮 purge 使此前任何“首份新快照”确认失效；删除 revision 之后真正
  // 出现的新记录会按 revisionCounter + 无镜像条件重新武装快速路径。
  postPurgeAiMemoryPersistRevisions.delete(chatId);
  const hadLatestSnapshot: boolean = latestAiMemories.delete(chatId);
  latestAiMemoryRevisions.delete(chatId);
  let revision: number | undefined = pendingAiMemoryDeletes.get(chatId);
  if (revision === undefined || hadLatestSnapshot) {
    revision = nextAiMemoryRevision(chatId);
    pendingAiMemoryDeletes.set(chatId, revision);
  }
  const persisted: Promise<void> | undefined = wait ? waitForAiMemoryDelete(chatId, revision) : undefined;
  if (postDiskIO({ type: "deleteAiMemory", chatId, revision }) === false && persisted !== undefined) {
    const waiters: AiMemoryDeleteWaiter[] = aiMemoryDeleteWaiters.get(chatId) ?? [];
    for (const waiter of [...waiters]) {
      if (waiter.revision !== revision) continue;
      clearTimeout(waiter.timer);
      removeDeleteWaiter(chatId, waiter);
      waiter.reject(new Error(`Persistence Worker rejected AI memory deletion for chat ${chatId}.`));
    }
  }
  return persisted;
}

onAiMemoryDeletedPersisted((reply: AiMemoryDeletedPersistedReply): void => {
  if (pendingAiMemoryDeletes.get(reply.chatId) === reply.revision) {
    pendingAiMemoryDeletes.delete(reply.chatId);
  }
  const waiters: AiMemoryDeleteWaiter[] = aiMemoryDeleteWaiters.get(reply.chatId) ?? [];
  for (const waiter of [...waiters]) {
    if (waiter.revision > reply.revision) continue;
    clearTimeout(waiter.timer);
    removeDeleteWaiter(reply.chatId, waiter);
    waiter.resolve();
  }
});

onAiMemoryPersisted((reply: AiMemoryPersistedReply): void => {
  const expectedRevision: number | null | undefined =
    postPurgeAiMemoryPersistRevisions.get(reply.chatId);
  if (expectedRevision === undefined || expectedRevision === null) return;
  if (reply.revision >= expectedRevision) {
    postPurgeAiMemoryPersistRevisions.delete(reply.chatId);
  }
});

// diskIOWorker 崩溃重建后，把当前记忆/贴纸目录镜像整份重发给它，补齐上
// 一次成功落盘之后的增量（见 infra/diskIO.ts 的 onDiskIORespawn 注释）。
onDiskIORespawn((): void => {
  for (const [chatId, revision] of pendingAiMemoryDeletes) {
    postDiskIO({ type: "deleteAiMemory", chatId, revision });
  }
  for (const [chatId, snapshot] of latestAiMemories) {
    const revision: number = latestAiMemoryRevisions.get(chatId) ?? 0;
    const immediateRevision: number | null | undefined =
      postPurgeAiMemoryPersistRevisions.get(chatId);
    postDiskIO({
      type: "aiMemory",
      chatId,
      revision,
      snapshot,
      ...(immediateRevision !== undefined &&
      immediateRevision !== null &&
      revision >= immediateRevision
        ? { persistImmediately: true }
        : {}),
    });
  }
  for (const [pack, snapshot] of latestStickerCatalogs) {
    postDiskIO({ type: "stickerCatalog", pack, snapshot });
  }
});
