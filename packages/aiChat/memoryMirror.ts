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
  aiMemoryRevisionCounters,
  latestAiMemories,
  latestAiMemoryRevisions,
  latestStickerCatalogs,
  pendingAiMemoryDeletes,
  postPurgeAiMemoryPersistRevisions,
} from "../cache/main/aiChat";
import { AI_MEMORY_FLUSH_TIMEOUT_MS } from "../consts/lifecycle";
import type { AiMemoryDeleteWaiter } from "../types/aiChat/waiters";
import type {
  AiMemoryDeletedPersistedReply,
  AiMemoryPersistedReply,
  DiskIORecoveryTransport,
} from "../types/diskIO";

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
  const revision: number = (aiMemoryRevisionCounters.get(chatId) ?? 0) + 1;
  aiMemoryRevisionCounters.set(chatId, revision);
  return revision;
}

/**
 * 群彻底不再由本机器人看管之后，丢掉它的 revision 计数器，并让 Disk I/O Worker
 * 同步丢掉自己那份水位线。
 *
 * 只有 teardown 能做，`/ai_chat disable` 不行：计数器要在一个 chat 的整个生命
 * 周期里单调递增，归零后的 revision 1 会与在途墓碑撞号；postMemoryRecord 还用
 * 「计数器还在」表示「刚被 purge、下一条新记录要立刻落盘」，disable 后重新开启
 * 正需要它。teardown 时调用方已 await 过 durable 删除，群再回来等同于新群。
 *
 * **两侧必须同一时刻归零**：Worker 侧的 `aiMemoryRevisions` 停在删除时的高水位，
 * 而这里从 1 重新开始，重新入群/重新授权后的每一份快照都会被判成迟到消息静默
 * 丢弃，一直丢到计数器重新爬过旧水位为止（期间进程重启即全丢，且零日志）。
 * 这条 forgetAiMemory 与前面的删除同走 postDiskIO 的 FIFO，顺序天然在删除之后。
 *
 * 还有任何在途状态就跳过，留给下一次：它们都按 revision 比大小，而这四项为空
 * 正是「此刻没有任何在途操作、丢掉水位线不会放行迟到 upsert」的判据。
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
  aiMemoryRevisionCounters.delete(chatId);
  // 投递失败无需补偿：Worker 不可用意味着它即将重建，而重建后的 hydrate 只按
  // 磁盘现存快照重算水位线——该群的快照已经删了，水位线自然也不会再出现。
  postDiskIO({ type: "forgetAiMemory", chatId });
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
