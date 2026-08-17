/**
 * 黑名单群级处置 durable outbox 的主线程 owner。
 *
 * 本模块持有启动恢复、write-ahead、任务编号/裁剪、业务 Worker 交付，以及
 * Disk I/O Worker 重建后的重放边界；补扫的退避与回执状态机在 sweep.ts。
 * 它不调用 Telegram API，执行 owner 通过单槽 holder 反向注册。
 * @see ../../../docs/cn/04-invariants.md
 */

import {
  blockedMemberRemoverHolder,
  blocklistRemovalCounter,
  blocklistSweepPages,
  blocklistSweepState,
  clearBlocklistSweepState,
  pendingBlockedRemovals,
} from "../../cache/main/blocklist";
import {
  removalSnapshotRevision,
  unacknowledgedRemovalSnapshotRevision,
} from "../../cache/main/identityStorage";
import { BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES } from "../../consts/antiRaid/blocklist";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import {
  flushDiskIODomain,
  onDiskIORespawn,
  onIdentityStoragePersisted,
  postDiskIO,
} from "../diskIO";
import { logger } from "../logger";
import { getChatStateCache } from "../storage/stateStore";
import { hasAnyBlockedIdentity } from "../identityStorage";
import type {
  BlockedMemberRemover,
  PendingBlockedRemoval,
  PendingBlockedRemovalParams,
  RemoveBlockedMembersParams,
  TrackBlockedRemovalInput,
} from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";
import type {
  BlocklistRemovalsDiskMessage,
  DiskIORecoveryTransport,
  IdentityStoragePersistedReply,
} from "../../types/diskIO";
import type { FlushResult } from "../../types/lifecycle";
import type { BlocklistSweepRecord } from "../../types/blocklist";

/** 恢复出的权限闩锁不重投；等确证权限恢复后以一条新补扫取代旧任务。 */
function restorePermissionBlockedSweep(
  chatId: number,
  pending: PendingBlockedRemoval
): void {
  const current: BlocklistSweepRecord | undefined =
    blocklistSweepState.get(chatId);
  blocklistSweepState.set(chatId, {
    removalId: null,
    sweptAt: null,
    nextRetryAt: Math.min(
      current?.nextRetryAt ?? pending.createdAt,
      pending.createdAt
    ),
    resweepRequested: false,
    failedSweeps: Math.max(
      current?.failedSweeps ?? 0,
      pending.attempts
    ),
    permissionBlocked: true,
  });
}

/**
 * 启动恢复：把 SQLite 当前格式 outbox 灌入主线程镜像。必须在 runner 开始
 * 投喂更新之前完成，否则启动瞬间进群的黑名单用户会漏踢。
 */
export function hydrateBlocklist(
  recoveredRemovals: Map<number, PendingBlockedRemoval> = new Map()
): void {
  pendingBlockedRemovals.clear();
  blocklistSweepState.clear();
  blocklistSweepPages.clear();
  blocklistRemovalCounter.current = 0;
  let filtered: boolean = false;
  for (const [removalId, pending] of recoveredRemovals) {
    blocklistRemovalCounter.current = Math.max(blocklistRemovalCounter.current, removalId);
    const state: ChatState | undefined = getChatStateCache().get(pending.params.chatId);
    if (state?.isInitEnabled !== true || state.botPermissions?.isAdministrator !== true) {
      filtered = true;
      continue;
    }
    // 补扫不带名单，投递时按当前名单现算；名单为空时任务已没有目标，应销账。
    if (pending.params.probeMembership) {
      if (!hasAnyBlockedIdentity()) {
        filtered = true;
        continue;
      }
      pendingBlockedRemovals.set(removalId, { ...pending });
      if (pending.lastFailure === "missing-permission") {
        restorePermissionBlockedSweep(pending.params.chatId, pending);
      } else if (
        blocklistSweepState.get(pending.params.chatId)?.permissionBlocked !== true
      ) {
        blocklistSweepState.set(pending.params.chatId, {
          removalId,
          sweptAt: null,
          nextRetryAt: pending.createdAt,
          resweepRequested: false,
          failedSweeps: pending.attempts,
          permissionBlocked: false,
        });
      }
      continue;
    }
    // 冻结批次在这里**不再裁剪**，因为 SQLite owner 根本不会交出需要裁剪的行：
    // hydrateStorageDatabase 对「冻结 userId 不在 blocklist_entries」直接抛错，
    // handlePendingRemovalSnapshot 对同一条件也抛（见 workers/diskIO/
    // storageDatabase/pendingRemoval.ts）。也就是说这是一条断言而不是一次修剪——部署方从旧备份
    // 恢复 database/storage.sqlite、或手删一行 blocklist_entries 撤销误 /block 时，
    // 进程会在启动阶段以非零码退出并点名那一行，按 AGENTS.md「不为用户行为兜底」
    // 要求运维显式修好数据，而不是让本函数悄悄丢掉一批待踢成员。
    const userIds: number[] = [...pending.params.userIds];
    pendingBlockedRemovals.set(removalId, {
      params: { ...pending.params, userIds },
      createdAt: pending.createdAt,
      attempts: pending.attempts,
      lastFailure: pending.lastFailure,
    });
    if (pending.lastFailure === "missing-permission") {
      restorePermissionBlockedSweep(pending.params.chatId, pending);
    }
  }
  if (filtered && !queuePendingBlockedRemovalsSnapshot()) {
    logger.error("Failed to queue the filtered blocklist removal outbox after startup recovery.");
  }
}

/**
 * 把主线程权威镜像完整投给 Disk I/O Worker。写入端逐字段重建并标脏，紧随
 * 其后的领域 flush 才是 durable 边界；这里不做 structured clone 之外的深拷贝。
 * @internal 供同目录 sweep owner 合并权威变更。
 */
type BlocklistSnapshotPoster = (message: BlocklistRemovalsDiskMessage) => boolean;

export function queuePendingBlockedRemovalsSnapshot(
  postMessage: BlocklistSnapshotPoster = postDiskIO
): boolean {
  if (!Number.isSafeInteger(removalSnapshotRevision.current + 1)) {
    throw new Error("Pending removal snapshot revision space is exhausted.");
  }
  removalSnapshotRevision.current++;
  const revision: number = removalSnapshotRevision.current;
  unacknowledgedRemovalSnapshotRevision.current = revision;
  return postMessage({
    type: "blocklistRemovals",
    removals: [...pendingBlockedRemovals],
    revision,
  } satisfies BlocklistRemovalsDiskMessage);
}

/** Anti-Raid 投递前的 write-ahead 边界。 */
export async function persistPendingBlockedRemovals(): Promise<void> {
  if (!queuePendingBlockedRemovalsSnapshot()) {
    throw new Error("Persistence Worker rejected the blocklist removal outbox snapshot.");
  }
  const result: FlushResult = await flushDiskIODomain("blocklistRemovalOutbox");
  if (result !== "flushed") {
    throw new Error(`Blocklist removal outbox flush ${result}.`);
  }
}

/**
 * 把持久化任务补成可交给业务 Worker 的具体批次。补扫在这一刻读取当前黑名单，
 * 其它任务沿用登记时冻结的名单；空名单补扫返回 undefined。
 * @internal 供同目录 sweep owner 在 Worker 重建时重放。
 */
export function materializeRemovalParams(
  params: PendingBlockedRemovalParams,
  blockedIds: readonly number[] = []
): RemoveBlockedMembersParams | undefined {
  if (!params.probeMembership) {
    return { ...params, userIds: [...params.userIds] };
  }
  if (blockedIds.length === 0) return undefined;
  return {
    chatId: params.chatId,
    probeMembership: true,
    removalId: params.removalId,
    userIds: [...blockedIds],
  };
}

/**
 * 读取权威镜像仍持有的处置参数并返回副本，供 write-ahead flush 前后对账。
 */
export function getPendingBlockedRemovalParams(
  removalId: number,
  blockedIds: readonly number[] = []
): RemoveBlockedMembersParams | undefined {
  const pending: PendingBlockedRemoval | undefined = pendingBlockedRemovals.get(removalId);
  if (pending === undefined) return undefined;
  return materializeRemovalParams(pending.params, blockedIds);
}

/**
 * 放掉某个群补扫进度里的在途占位；只在任务已被权威销账、不会再有回执时调用。
 * @internal outbox 裁剪路径专用。
 */
function releaseSweepClaim(chatId: number, removalId: number): void {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress?.removalId !== removalId) return;
  blocklistSweepState.set(chatId, { ...progress, removalId: null });
}

/**
 * 把某个 id 从冻结名单批次摘掉。补扫不冻结名单，只有权威名单被清空时才连同
 * 补扫任务一起销账；所有销账路径同步释放永远不会再收到回执的 sweep claim。
 * @internal 由 membership.ts 的 /unblock 路径调用。
 */
export function forgetUserBlocklistRemovals(userId: number): void {
  let changed: boolean = false;
  const blocklistEmptied: boolean = !hasAnyBlockedIdentity();
  for (const [removalId, pending] of pendingBlockedRemovals) {
    if (pending.params.probeMembership) {
      if (!blocklistEmptied) continue;
      pendingBlockedRemovals.delete(removalId);
      blocklistSweepPages.delete(removalId);
      releaseSweepClaim(pending.params.chatId, removalId);
      changed = true;
      continue;
    }
    if (!pending.params.userIds.includes(userId)) continue;
    const remaining: number[] = pending.params.userIds.filter((id: number): boolean => id !== userId);
    if (remaining.length === 0) {
      pendingBlockedRemovals.delete(removalId);
      blocklistSweepPages.delete(removalId);
      releaseSweepClaim(pending.params.chatId, removalId);
    } else {
      pendingBlockedRemovals.set(removalId, {
        ...pending,
        params: { ...pending.params, userIds: remaining },
      });
    }
    changed = true;
  }
  if (changed && !queuePendingBlockedRemovalsSnapshot()) {
    logger.error(`Failed to queue blocklist removal outbox cleanup for unblocked user ${userId}.`);
  }
}

/** 上层 owner 反向注册黑名单处置执行者；本 infra 模块不静态依赖 Anti-Raid。 */
export function registerBlockedMemberRemover(remover: BlockedMemberRemover): void {
  blockedMemberRemoverHolder.current = remover;
}

/**
 * 给一批处置编号并登记镜像。补扫只存任务，其余批次冻结并去重具体名单。
 */
export function trackBlockedRemoval(
  input: TrackBlockedRemovalInput,
  blockedIds: readonly number[] = []
): RemoveBlockedMembersParams {
  if (pendingBlockedRemovals.size >= BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
    throw new Error(
      `Blocklist removal outbox reached its ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES}-entry capacity.`
    );
  }
  if (!Number.isSafeInteger(blocklistRemovalCounter.current + 1)) {
    throw new Error("Blocklist removal id space is exhausted.");
  }
  blocklistRemovalCounter.current++;
  const removalId: number = blocklistRemovalCounter.current;
  const stored: PendingBlockedRemovalParams = input.probeMembership
    ? { chatId: input.chatId, probeMembership: true, removalId }
    : { ...input, userIds: [...new Set(input.userIds)], removalId };
  pendingBlockedRemovals.set(removalId, {
    params: stored,
    createdAt: Date.now(),
    attempts: 0,
    lastFailure: null,
  });
  const tracked: RemoveBlockedMembersParams | undefined = materializeRemovalParams(stored, blockedIds);
  if (tracked === undefined) {
    pendingBlockedRemovals.delete(removalId);
    throw new Error("Blocklist removal has no target to enforce.");
  }
  return tracked;
}

/** 把已登记镜像的一批处置交给当前 Anti-Raid 执行 owner；返回真正投出的条数。 */
export function dispatchBlockedRemovals(
  removals: readonly RemoveBlockedMembersParams[]
): Promise<number> {
  return blockedMemberRemoverHolder.current(removals);
}

/**
 * 群停止管理时删除其全部任务与 sweep 进度。主线程是这个取消边界的权威 owner；
 * Worker isolate 里的世代在重建后会归零，不能代替这里的 durable 裁剪。
 */
export function forgetChatBlocklistWork(chatId: number): void {
  let changed: boolean = false;
  for (const [removalId, pending] of pendingBlockedRemovals) {
    if (pending.params.chatId !== chatId) continue;
    pendingBlockedRemovals.delete(removalId);
    blocklistSweepPages.delete(removalId);
    changed = true;
  }
  if (changed && !queuePendingBlockedRemovalsSnapshot()) {
    logger.error(`Failed to queue blocklist removal outbox cleanup for unmanaged chat ${chatId}.`);
  }
  clearBlocklistSweepState(chatId);
}

function settleRemovalSnapshot(reply: IdentityStoragePersistedReply): void {
  if (
    reply.removalSnapshotRevision !== undefined &&
    unacknowledgedRemovalSnapshotRevision.current === reply.removalSnapshotRevision
  ) {
    unacknowledgedRemovalSnapshotRevision.current = null;
  }
}

onIdentityStoragePersisted(settleRemovalSnapshot);

// Disk I/O Worker 重建后只重放仍未收到事务 ACK 的最终 outbox 快照。
onDiskIORespawn("blocklist outbox", DISK_IO_RESPAWN_PRIORITIES.BLOCKLIST + 1, (
  transport: DiskIORecoveryTransport
): boolean => {
  const revision: number | null = unacknowledgedRemovalSnapshotRevision.current;
  if (revision === null) return true;
  return transport.post({
    type: "blocklistRemovals",
    removals: [...pendingBlockedRemovals],
    revision,
  } satisfies BlocklistRemovalsDiskMessage);
});
