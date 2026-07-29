/**
 * 黑名单补扫的主线程状态机：退避、权限闩锁、回执结算与 Worker 重建重放。
 *
 * durable 任务的编号、裁剪和 write-ahead 由 outbox.ts 持有；本模块只修改
 * blocklistSweepState 与任务诊断字段，并通过 outbox owner 合并完整快照。
 * @see ../../../docs/04-invariants.md
 */

import {
  blockedMemberRemoverHolder,
  blockedUserIds,
  blocklistSweepState,
  pendingBlockedRemovals,
} from "../../cache/blocklist";
import {
  BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS,
  BLOCKLIST_SWEEP_RETRY_INTERVAL_MS,
  BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS,
} from "../../consts/antiRaid/blocklist";
import { logger } from "../logger";
import {
  materializeRemovalParams,
  queuePendingBlockedRemovalsSnapshot,
  trackBlockedRemoval,
} from "./outbox";
import type { BlocklistSweepRecord } from "../../cache/blocklist";
import type { BlockedMembersRemovedEvent } from "../../types/antiRaid";
import type {
  BlocklistRemovalFailure,
  PendingBlockedRemoval,
  RemoveBlockedMembersParams,
} from "../../types/blocklist";

/**
 * 让这个群重新欠一次补扫，打开 sweptAt 闩锁。有批次在途时只记
 * resweepRequested，避免迟到的 complete 回执把请求覆盖；权限闩锁只能由一次
 * 确证的权限恢复打开。
 */
export function requestBlocklistResweep(
  chatId: number,
  nextRetryAt: number = Date.now()
): void {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress === undefined || progress.permissionBlocked) return;
  blocklistSweepState.set(chatId, {
    removalId: progress.removalId,
    sweptAt: null,
    nextRetryAt,
    resweepRequested: progress.removalId !== null,
    failedSweeps: progress.failedSweeps,
    permissionBlocked: false,
  });
}

/**
 * 记下缺封禁权限，并把对应 outbox 批次标成 missing-permission。没有既有 sweep
 * 记录时也建立最小闩锁，确保 Worker 重建不会反复重投同一批注定失败的任务。
 */
function notePermissionBlocked(chatId: number, removalId: number): void {
  recordPendingRemovalFailure(removalId, chatId, "missing-permission");
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  blocklistSweepState.set(chatId, progress === undefined
    ? {
      removalId: null,
      sweptAt: null,
      nextRetryAt: Date.now(),
      resweepRequested: false,
      failedSweeps: 0,
      permissionBlocked: true,
    }
    : { ...progress, permissionBlocked: true });
}

/**
 * 一次确证的封禁权限观测。只有 Telegram 明确表示权限恢复才重新武装补扫；
 * 观测不到权限位或仍无权限都保持闩锁。
 */
export function noteBanPermissionObserved(chatId: number, canRestrict: boolean): void {
  if (!canRestrict) return;
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress?.permissionBlocked !== true) return;
  logger.log(`Ban rights restored in chat ${chatId}; re-arming the blocklist sweep.`);
  blocklistSweepState.set(chatId, {
    removalId: progress.removalId,
    sweptAt: null,
    nextRetryAt: Date.now(),
    resweepRequested: progress.removalId !== null,
    failedSweeps: 0,
    permissionBlocked: false,
  });
}

/** 按连续失败次数线性放大重扫间隔，并封顶。 */
function sweepRetryDelayMs(failedSweeps: number): number {
  return Math.min(
    BLOCKLIST_SWEEP_RETRY_INTERVAL_MS * (failedSweeps + 1),
    BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS
  );
}

/** 退避顶到上限后不再自增；该计数只服务于延迟计算。 */
function nextFailedSweeps(failedSweeps: number): number {
  return sweepRetryDelayMs(failedSweeps) >= BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS
    ? failedSweeps
    : failedSweeps + 1;
}

/** 新一轮补扫完整取代同群旧批次，避免 outbox 与重放量随失败轮次增长。 */
function forgetChatSweepBatches(chatId: number, exceptRemovalId?: number): void {
  let changed: boolean = false;
  for (const [removalId, pending] of pendingBlockedRemovals) {
    if (
      pending.params.chatId === chatId &&
      pending.params.probeMembership &&
      removalId !== exceptRemovalId
    ) {
      pendingBlockedRemovals.delete(removalId);
      changed = true;
    }
  }
  if (changed && !queuePendingBlockedRemovalsSnapshot()) {
    logger.error(`Failed to queue superseded blocklist sweep cleanup for chat ${chatId}.`);
  }
}

/**
 * 把当前黑名单在某个已管理群中补扫一遍。只登记 durable 任务并交给执行 owner；
 * 具体名单由 outbox 在投递时现算，全部 Telegram 请求都在 Anti-Raid Worker。
 */
export async function sweepBlockedMembers(
  chatId: number,
  now: number = Date.now()
): Promise<void> {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress !== undefined && (
    progress.sweptAt !== null ||
    progress.removalId !== null ||
    progress.permissionBlocked ||
    now < progress.nextRetryAt
  )) {
    return;
  }
  if (blockedUserIds.size === 0) return;
  const failedSweeps: number = progress?.failedSweeps ?? 0;
  let params: RemoveBlockedMembersParams;
  try {
    params = trackBlockedRemoval({ chatId, probeMembership: true });
  } catch (error: unknown) {
    // 满仓或 id 耗尽必须在 update 内就地降级；抛出去会形成重投/重启循环。
    logger.error(`Failed to queue the blocklist sweep of chat ${chatId}:`, error);
    blocklistSweepState.set(chatId, {
      removalId: null,
      sweptAt: null,
      nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
      resweepRequested: false,
      failedSweeps,
      permissionBlocked: false,
    });
    return;
  }
  // 先成功登记新任务，再删旧任务，避免登记异常时把唯一恢复依据提前销掉。
  forgetChatSweepBatches(chatId, params.removalId);
  blocklistSweepState.set(chatId, {
    removalId: params.removalId,
    sweptAt: null,
    nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
    resweepRequested: false,
    failedSweeps,
    permissionBlocked: false,
  });
  try {
    await blockedMemberRemoverHolder.current([params]);
  } catch (error: unknown) {
    // 回执可能抢先到达；只有这批仍是当前 claim 时才写回失败，避免踩掉 sweptAt。
    if (blocklistSweepState.get(chatId)?.removalId === params.removalId) {
      recordPendingRemovalFailure(params.removalId, chatId, "delivery-boundary");
      blocklistSweepState.set(chatId, {
        removalId: null,
        sweptAt: null,
        nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
        resweepRequested: false,
        failedSweeps,
        permissionBlocked: false,
      });
    }
    throw error;
  }
}

/**
 * Worker 回执：complete 才销 durable 镜像并允许 sweptAt 落地；未落定任务永久
 * 留在 outbox，直到完成或权威状态取消。
 */
export function settleBlockedRemoval(event: BlockedMembersRemovedEvent): void {
  if (event.complete) {
    if (
      pendingBlockedRemovals.delete(event.removalId) &&
      !queuePendingBlockedRemovalsSnapshot()
    ) {
      logger.error(`Failed to queue completed blocklist removal cleanup ${event.removalId}.`);
    }
  } else if (event.permissionDenied === true) {
    logger.error(
      `Blocklist removal ${event.removalId} for chat ${event.chatId} is blocked by missing ban rights; ` +
      "it stays pending until the bot's permissions there change."
    );
    notePermissionBlocked(event.chatId, event.removalId);
  } else {
    logger.error(
      `Blocklist removal ${event.removalId} for chat ${event.chatId} did not fully settle; ` +
      "it will be retried."
    );
    recordPendingRemovalFailure(event.removalId, event.chatId, "side-effect-incomplete");
  }

  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(event.chatId);
  if (progress?.removalId !== event.removalId) {
    // 秒踢/广告批次不占 sweep claim；失败或目标是管理员时仍让该群欠一次补扫。
    if ((!event.complete || event.targetIsAdmin === true) && event.permissionDenied !== true) {
      requestBlocklistResweep(
        event.chatId,
        Date.now() + sweepRetryDelayMs(progress?.failedSweeps ?? 0)
      );
    }
    return;
  }

  const stillOwesSweep: boolean =
    progress.resweepRequested || event.targetIsAdmin === true;
  const failedSweeps: number = event.complete && !stillOwesSweep
    ? 0
    : nextFailedSweeps(progress.failedSweeps);
  blocklistSweepState.set(event.chatId, {
    removalId: null,
    sweptAt: event.complete && !stillOwesSweep ? Date.now() : null,
    nextRetryAt: progress.nextRetryAt,
    resweepRequested: false,
    failedSweeps,
    // notePermissionBlocked 可能刚置真，不能在同一回执收尾时覆盖。
    permissionBlocked: blocklistSweepState.get(event.chatId)?.permissionBlocked === true,
  });
}

/** 更新一次任务诊断；达到阈值只告警，不删除安全任务。 */
function updatePendingRemovalFailure(
  removalId: number,
  chatId: number,
  failure: BlocklistRemovalFailure
): boolean {
  const pending: PendingBlockedRemoval | undefined = pendingBlockedRemovals.get(removalId);
  if (pending === undefined) return false;
  if (pending.attempts < Number.MAX_SAFE_INTEGER) pending.attempts++;
  pending.lastFailure = failure;
  if (pending.attempts === BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS) {
    logger.error(
      `Blocklist removal ${removalId} for chat ${chatId} failed ${pending.attempts} time(s); ` +
      "retaining its durable outbox entry until completion or authoritative cancellation."
    );
  }
  return true;
}

/**
 * 中间诊断变化不逐次整表持久化，避免 N 份回执形成 O(n²) 快照/fsync；只有首次
 * 跨越告警阈值立即排队，使“已达到告警线”本身跨重启存活。
 */
function recordPendingRemovalFailure(
  removalId: number,
  chatId: number,
  failure: BlocklistRemovalFailure
): void {
  if (!updatePendingRemovalFailure(removalId, chatId, failure)) return;
  if (
    pendingBlockedRemovals.get(removalId)?.attempts !==
    BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS
  ) {
    return;
  }
  if (!queuePendingBlockedRemovalsSnapshot()) {
    logger.error(`Failed to queue blocklist removal retry state ${removalId}.`);
  }
}

/**
 * Anti-Raid Worker 重建后重投所有未销账任务。重复 ban 幂等，漏投则会把人永久
 * 留在群里；权限闩锁任务等待真实权限边沿，不因 Worker 重建空转。
 */
export function replayPendingBlockedRemovals(
  countPreviousAttempt: boolean = true
): void {
  const removals: RemoveBlockedMembersParams[] = [];
  for (const [removalId, pending] of [...pendingBlockedRemovals]) {
    if (
      blocklistSweepState.get(pending.params.chatId)?.permissionBlocked === true
    ) {
      continue;
    }
    const params: RemoveBlockedMembersParams | undefined =
      materializeRemovalParams(pending.params);
    if (params === undefined) continue;
    if (countPreviousAttempt) {
      updatePendingRemovalFailure(
        removalId,
        pending.params.chatId,
        "worker-restarted"
      );
    }
    removals.push(params);
  }
  if (removals.length === 0) return;
  void blockedMemberRemoverHolder.current(removals).catch((error: unknown): void => {
    logger.error(`Failed to replay ${removals.length} blocklist removal batch(es):`, error);
  });
}
