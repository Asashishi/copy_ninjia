import {
  onAiMemoryDeletedPersisted,
  onAiMemoryPersisted,
  onDiskIOGiveUp,
  onDiskIORespawn,
  postDiskIO,
} from "../infra/diskIO";
import { DISK_IO_RESPAWN_PRIORITIES } from "../consts/diskIO/common";
import {
  aiMemoryDeleteWaiters,
  aiChatWorkerState,
  aiMemoryRevisionCounters,
  aiMemoryRevisionFloor,
  aiMemoryUsages,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  pendingAiMemoryDeletes,
  pendingAiMemoryTeardowns,
  postPurgeAiMemoryPersistRevisions,
} from "../cache/main/aiChat";
import { AI_MEMORY_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import { STATE_MANAGED_CHAT_LIMIT } from "../consts/storage";
import { signalDiskIOFatal } from "../infra/diskIO/fatal";
import type { AiMemoryDeleteWaiter, AiMemoryTeardown } from "../types/aiChat/waiters";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
} from "../types/diskIO/replies";
import type { DiskIORecoveryTransport } from "../types/diskIO/messages";

/**
 * AI 记忆的主线程镜像侧（owner 是 packages/aiChat/index.ts）：按 chat 单调递增的
 * revision、待确认删除 tombstone、删除回执 waiter，以及 Disk I/O Worker 重建
 * 后的镜像重放。
 *
 * 这套状态与 aiChat/workerBridge.ts 里的 Worker 监督相互独立：aiChatWorker 崩溃靠
 * latestAiMemories 重放 hydrate（在 aiChat/workerBridge.ts 的 onRespawn 里），diskIOWorker
 * 崩溃靠本文件的 onDiskIORespawn 重放 tombstone 与最新快照。只有 durable 删除
 * 回执能释放 tombstone。
 * @see ../../docs/cn/04-invariants.md
 */

/** 取该群下一个记忆 revision；镜像与 tombstone 都以它判定新旧。 */
export function nextAiMemoryRevision(chatId: number): number {
  const revision: number = (aiMemoryRevisionCounters.get(chatId) ?? aiMemoryRevisionFloor.current) + 1;
  aiMemoryRevisionCounters.set(chatId, revision);
  return revision;
}

/**
 * teardown 在 durable 删除与 AI Worker 失效均完成后释放两侧水位。
 * 任一新快照、首份持久化标志、墓碑或 waiter 仍在时保留计数。
 * 全局标量记录已释放的最高 revision，新生命周期从其后分配，拒绝旧回执撞号；
 * DiskIO forget 沿删除所在 FIFO 投递。普通禁用仍保留计数以武装首份快照。
 */
export function forgetAiMemoryRevisionCounter(chatId: number): void {
  if (
    pendingAiMemoryDeletes.has(chatId) ||
    aiMemoryDeleteWaiters.has(chatId) ||
    postPurgeAiMemoryPersistRevisions.has(chatId) ||
    latestAiMemories.has(chatId)
  ) {
    return;
  }
  aiMemoryRevisionFloor.current = Math.max(aiMemoryRevisionFloor.current, aiMemoryRevisionCounters.get(chatId) ?? 0);
  aiMemoryRevisionCounters.delete(chatId);
  // forget 与已确认删除共用 FIFO；拒收由 DiskIO fatal/重建边界处理。
  postDiskIO({ type: "forgetAiMemory", chatId });
}

/** 开始彻底清理并保留超时后的收尾责任，普通禁用不建立此身份。 */
export function beginAiMemoryTeardown(chatId: number): void {
  if (!pendingAiMemoryTeardowns.has(chatId) && pendingAiMemoryTeardowns.size >= STATE_MANAGED_CHAT_LIMIT) {
    const error: Error = new Error("AI memory teardown capacity was exhausted.");
    signalDiskIOFatal(error);
    throw error;
  }
  pendingAiMemoryTeardowns.set(chatId, { requestId: null, workerSettled: !aiChatWorkerState.available });
}

/** 在回执或 teardown 结算点检查收尾；新记忆接管时只撤销旧身份，不改新代水位。 */
export function finishAiMemoryTeardown(chatId: number): void {
  const teardown: AiMemoryTeardown | undefined = pendingAiMemoryTeardowns.get(chatId);
  if (teardown === undefined) return;
  if (latestAiMemories.has(chatId) || postPurgeAiMemoryPersistRevisions.has(chatId)) {
    pendingAiMemoryTeardowns.delete(chatId);
    return;
  }
  if (!teardown.workerSettled || pendingAiMemoryDeletes.has(chatId) || aiMemoryDeleteWaiters.has(chatId)) return;
  forgetAiMemoryRevisionCounter(chatId);
  pendingAiMemoryTeardowns.delete(chatId);
}

/** 旧 AI Worker 已终止，其 invalidate 请求不再等待；durable 删除仍由 DiskIO 回执拥有。 */
export function settleAiMemoryTeardownWorker(): void {
  for (const [chatId, teardown] of pendingAiMemoryTeardowns) {
    teardown.workerSettled = true;
    finishAiMemoryTeardown(chatId);
  }
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
  // 出现的新记录会按 aiMemoryRevisionCounters + 无镜像条件重新武装快速路径。
  postPurgeAiMemoryPersistRevisions.delete(chatId);
  const hadLatestSnapshot: boolean = latestAiMemories.delete(chatId);
  latestAiMemoryRevisions.delete(chatId);
  // 展示用的占用量镜像与快照镜像同生共死：这一刻起本群没有可展示的上下文，
  // `/bot_status` 按「无条目 = 0」如实显示（见 cache/main/aiChat.ts 的 aiMemoryUsages）。
  aiMemoryUsages.delete(chatId);
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

onDiskIOGiveUp((): void => {
  // Worker 已经放弃自愈，没有替补实例：onDiskIORespawn 不会跑，deleteAiMemory
  // 不会重放，durable 回执永远不会来。此时不结算的话，命令与 teardown 只能干等
  // 满 AI_MEMORY_FLUSH_TIMEOUT_MS 再报「超时」——那两秒恰好和同一个 fatal 信号
  // 触发的停机抢排空预算，失败原因也被表述成超时而不是「Worker 已经放弃」。
  for (const waiters of aiMemoryDeleteWaiters.values()) {
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(
        "Persistence Worker gave up self-healing before the AI memory deletion was durable."
      ));
    }
  }
  aiMemoryDeleteWaiters.clear();
});

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
  finishAiMemoryTeardown(reply.chatId);
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
onDiskIORespawn("AI memory", DISK_IO_RESPAWN_PRIORITIES.AI_MEMORY, (transport: DiskIORecoveryTransport): boolean => {
  for (const [chatId, revision] of pendingAiMemoryDeletes) {
    if (!transport.post({ type: "deleteAiMemory", chatId, revision })) return false;
  }
  for (const [chatId, snapshot] of latestAiMemories) {
    const revision: number = latestAiMemoryRevisions.get(chatId) ?? 0;
    const immediateRevision: number | null | undefined =
      postPurgeAiMemoryPersistRevisions.get(chatId);
    if (!transport.post({
      type: "aiMemory",
      chatId,
      revision,
      snapshot,
      ...(immediateRevision !== undefined &&
      immediateRevision !== null &&
      revision >= immediateRevision
        ? { persistImmediately: true }
        : {}),
    })) {
      return false;
    }
  }
  for (const [pack, snapshot] of latestStickerCatalogs) {
    if (!transport.post({ type: "stickerCatalog", pack, snapshot })) return false;
  }
  return true;
});
