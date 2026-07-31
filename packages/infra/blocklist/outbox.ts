/**
 * 黑名单群级处置 durable outbox 的主线程 owner。
 *
 * 本模块持有启动恢复、write-ahead、任务编号/裁剪、业务 Worker 交付，以及
 * Disk I/O Worker 重建后的重放边界；补扫的退避与回执状态机在 sweep.ts。
 * 它不调用 Telegram API，执行 owner 通过单槽 holder 反向注册。
 * @see ../../../docs/04-invariants.md
 */

import {
  blockedMemberRemoverHolder,
  blockedUserIds,
  blocklistRemovalCounter,
  blocklistSweepState,
  clearBlocklistSweepState,
  configuredBlockedIds,
  pendingBlockedRemovals,
  sessionBlockedAt,
  sessionUnblockedIds,
} from "../../cache/main/blocklist";
import { BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES } from "../../consts/antiRaid/blocklist";
import { flushDiskIODomain, onDiskIORespawn, postDiskIO } from "../diskIO";
import { logger } from "../logger";
import { getAllChatStates } from "../storage/stateStore";
import {
  hasBlockedIdentities,
  isBlockedIdentity,
  listBlockedIdentityIds,
} from "./identities";
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
  BlockUserDiskMessage,
  BlockedUserRecord,
  DiskIORecoveryTransport,
  UnblockUserDiskMessage,
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
 * 启动恢复：把静态配置层、动态 memory 层与当前格式 outbox 一并灌入主线程
 * 镜像。必须在 runner 开始投喂更新之前完成，否则启动瞬间进群的黑名单用户
 * 会漏踢。
 */
export function hydrateBlocklist(
  blocked: Map<number, BlockedUserRecord>,
  recoveredRemovals: Map<number, PendingBlockedRemoval> = new Map(),
  configuredIds: readonly number[] = []
): void {
  blockedUserIds.clear();
  configuredBlockedIds.clear();
  sessionBlockedAt.clear();
  sessionUnblockedIds.clear();
  pendingBlockedRemovals.clear();
  blocklistSweepState.clear();
  blocklistRemovalCounter.current = 0;
  for (const id of configuredIds) configuredBlockedIds.add(id);
  for (const [userId, record] of blocked) blockedUserIds.set(userId, { ...record });
  let filtered: boolean = false;
  for (const [removalId, pending] of recoveredRemovals) {
    blocklistRemovalCounter.current = Math.max(blocklistRemovalCounter.current, removalId);
    const state: ChatState | undefined = getAllChatStates().get(pending.params.chatId);
    if (state?.isInitEnabled !== true || state.botIsAdmin !== true) {
      filtered = true;
      continue;
    }
    // 补扫不带名单，投递时按当前名单现算；名单为空时任务已没有目标，应销账。
    if (pending.params.probeMembership) {
      if (!hasBlockedIdentities()) {
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
    // 冻结名单批次按当前权威名单裁剪：停机期间可能已经人工解除了一部分。
    const userIds: number[] = pending.params.userIds.filter(
      (userId: number): boolean => isBlockedIdentity(userId)
    );
    if (userIds.length === 0) {
      filtered = true;
      continue;
    }
    if (userIds.length !== pending.params.userIds.length) filtered = true;
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
  return postMessage({
    type: "blocklistRemovals",
    removals: [...pendingBlockedRemovals],
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
  params: PendingBlockedRemovalParams
): RemoveBlockedMembersParams | undefined {
  if (!params.probeMembership) {
    return { ...params, userIds: [...params.userIds] };
  }
  const userIds: number[] = listBlockedIdentityIds();
  if (userIds.length === 0) return undefined;
  return { chatId: params.chatId, probeMembership: true, removalId: params.removalId, userIds };
}

/**
 * 读取权威镜像仍持有的处置参数并返回副本，供 write-ahead flush 前后对账。
 */
export function getPendingBlockedRemovalParams(
  removalId: number
): RemoveBlockedMembersParams | undefined {
  const pending: PendingBlockedRemoval | undefined = pendingBlockedRemovals.get(removalId);
  if (pending === undefined) return undefined;
  return materializeRemovalParams(pending.params);
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
  const blocklistEmptied: boolean = !hasBlockedIdentities();
  for (const [removalId, pending] of pendingBlockedRemovals) {
    if (pending.params.probeMembership) {
      if (!blocklistEmptied) continue;
      pendingBlockedRemovals.delete(removalId);
      releaseSweepClaim(pending.params.chatId, removalId);
      changed = true;
      continue;
    }
    if (!pending.params.userIds.includes(userId)) continue;
    const remaining: number[] = pending.params.userIds.filter((id: number): boolean => id !== userId);
    if (remaining.length === 0) {
      pendingBlockedRemovals.delete(removalId);
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
export function trackBlockedRemoval(input: TrackBlockedRemovalInput): RemoveBlockedMembersParams {
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
  const tracked: RemoveBlockedMembersParams | undefined = materializeRemovalParams(stored);
  if (tracked === undefined) {
    pendingBlockedRemovals.delete(removalId);
    throw new Error("Blocklist removal has no target to enforce.");
  }
  return tracked;
}

/** 把已登记镜像的一批处置交给当前 Anti-Raid 执行 owner。 */
export function dispatchBlockedRemovals(
  removals: readonly RemoveBlockedMembersParams[]
): Promise<void> {
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
    changed = true;
  }
  if (changed && !queuePendingBlockedRemovalsSnapshot()) {
    logger.error(`Failed to queue blocklist removal outbox cleanup for unmanaged chat ${chatId}.`);
  }
  clearBlocklistSweepState(chatId);
}

// Disk I/O Worker 重建后恢复当前进程内尚未落定的增删与完整 outbox 镜像。
onDiskIORespawn("blocklist", (transport: DiskIORecoveryTransport): boolean => {
  if (!queuePendingBlockedRemovalsSnapshot(transport.post)) return false;
  // 追加文件无法表达删除：本进程只要解除过一次，就必须整份重写当前名单。
  if (sessionUnblockedIds.size > 0) {
    return transport.post({
      type: "unblockUser",
      blocked: [...blockedUserIds],
    } satisfies UnblockUserDiskMessage);
  }
  for (const [userId, blockedAt] of sessionBlockedAt) {
    if (!transport.post({
      type: "blockUser",
      userId,
      blockedAt,
    } satisfies BlockUserDiskMessage)) return false;
  }
  return true;
});
