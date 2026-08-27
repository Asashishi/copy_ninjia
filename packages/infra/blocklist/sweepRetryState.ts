import {
  blocklistSweepState,
  pendingBlockedRemovals,
} from "../../cache/main/blocklist";
import {
  BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS,
  BLOCKLIST_SWEEP_RETRY_INTERVAL_MS,
  BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS,
} from "../../consts/antiRaid/blocklist";
import type {
  BlocklistRemovalFailure,
  BlocklistSweepRecord,
  PendingBlockedRemoval,
} from "../../types/blocklist";
import { logger } from "../logger";
import { queuePendingBlockedRemovalsSnapshot } from "./outbox";
import { armBlocklistSweepScheduler } from "./sweepScheduler";

/** 按连续失败次数线性放大重扫间隔，并封顶。 */
export function sweepRetryDelayMs(failedSweeps: number): number {
  return Math.min(
    BLOCKLIST_SWEEP_RETRY_INTERVAL_MS * (failedSweeps + 1),
    BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS
  );
}

/** 退避顶到上限后不再自增；该计数只服务于延迟计算。 */
export function nextFailedSweeps(failedSweeps: number): number {
  return sweepRetryDelayMs(failedSweeps) >= BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS
    ? failedSweeps
    : failedSweeps + 1;
}

/** 让一个未被权限闩锁的群重新欠一次补扫。 */
export function requestBlocklistResweep(
  chatId: number,
  nextRetryAt: number = Date.now()
): void {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress?.permissionBlocked === true) return;
  blocklistSweepState.set(chatId, {
    removalId: progress?.removalId ?? null,
    sweptAt: null,
    nextRetryAt,
    resweepRequested:
      progress?.removalId !== null && progress?.removalId !== undefined,
    failedSweeps: progress?.failedSweeps ?? 0,
    permissionBlocked: false,
  });
  armBlocklistSweepScheduler();
}

/** 清掉当前 claim、推进失败计数并按退避截止时间重排。 */
export function noteSweepAttemptFailed(
  chatId: number,
  failedSweeps: number,
  now: number
): void {
  blocklistSweepState.set(chatId, {
    removalId: null,
    sweptAt: null,
    nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
    resweepRequested: false,
    failedSweeps: nextFailedSweeps(failedSweeps),
    permissionBlocked:
      blocklistSweepState.get(chatId)?.permissionBlocked === true,
  });
  armBlocklistSweepScheduler();
}

/** 更新一次任务诊断；达到阈值只告警，不删除安全任务。 */
export function updatePendingRemovalFailure(
  removalId: number,
  chatId: number,
  failure: BlocklistRemovalFailure
): boolean {
  const pending: PendingBlockedRemoval | undefined =
    pendingBlockedRemovals.get(removalId);
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

/** 告警阈值首次跨越时把诊断状态纳入下一份 durable outbox 快照。 */
export function recordPendingRemovalFailure(
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
