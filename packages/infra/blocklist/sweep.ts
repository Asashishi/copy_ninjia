/**
 * 黑名单补扫的主线程状态机：退避、权限闩锁、回执结算与 Worker 重建重放。
 *
 * durable 任务的编号、裁剪和 write-ahead 由 outbox.ts 持有；本模块只修改
 * blocklistSweepState 与任务诊断字段，并通过 outbox owner 合并完整快照。
 * @see ../../../docs/04-invariants.md
 */

import {
  blockedMemberRemoverHolder,
  blocklistSweepState,
  pendingBlockedRemovals,
} from "../../cache/main/blocklist";
import {
  BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS,
  BLOCKLIST_SWEEP_RETRY_INTERVAL_MS,
  BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS,
} from "../../consts/antiRaid/blocklist";
import { logger } from "../logger";
import { getAllChatStates } from "../storage/stateStore";
import { hasBlockedIdentities } from "./identities";
import {
  materializeRemovalParams,
  queuePendingBlockedRemovalsSnapshot,
  trackBlockedRemoval,
} from "./outbox";
import type { BlockedMembersRemovedEvent } from "../../types/antiRaid";
import type {
  BlocklistRemovalFailure,
  BlocklistSweepRecord,
  PendingBlockedRemoval,
  RemoveBlockedMembersParams,
} from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";

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
  // frozen 秒踢/广告批次各自还带着独立 removalId，新的全名单补扫不会替它们
  // 回执销账。权限边沿到达时先整批重新交给 Worker，让各批按自己的 complete
  // 回执收敛；随后 recordBotAdminStatus 仍会调用 sweepBlockedMembers，覆盖
  // `/block` 直接封禁失败但从未建立 frozen pending 的成员。
  replayPendingBlockedRemovalsForChat(chatId);
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

/**
 * 「这一轮没成，排下一次」的统一记账：清掉 claim、按当前计数排期、把计数推进一格。
 *
 * 收成一处而不是在各失败路径各写一份六字段字面量——散着写正是退避永不增长的成因：
 * `sweepBlockedMembers` 的两条降级路径（登记不进 outbox、投递边界抛错）原样回写
 * failedSweeps，而 nextFailedSweeps 此前只在回执结算里调用。执行 owner 持续抛错
 * （Worker 不可用、outbox 满）时，每次重试都按基础间隔 BLOCKLIST_SWEEP_RETRY_INTERVAL_MS
 * 排期、永远走不到 BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS，每一轮还烧掉一个 outbox
 * id 加一行错误日志。
 *
 * nextRetryAt 用**推进前**的计数算，与回执那条路径保持同一口径（那边排期用的是
 * 派发时写下的 nextRetryAt，计数留给下一轮）。
 */
function noteSweepAttemptFailed(chatId: number, failedSweeps: number, now: number): void {
  blocklistSweepState.set(chatId, {
    removalId: null,
    sweptAt: null,
    nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
    resweepRequested: false,
    failedSweeps: nextFailedSweeps(failedSweeps),
    permissionBlocked: false,
  });
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

interface PreparedBlocklistSweep {
  chatId: number;
  params: RemoveBlockedMembersParams;
  failedSweeps: number;
  now: number;
}

/** 建立一条补扫 claim；无需补扫或登记失败时返回 null。 */
function prepareBlocklistSweep(
  chatId: number,
  now: number = Date.now()
): PreparedBlocklistSweep | null {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress !== undefined && (
    progress.sweptAt !== null ||
    progress.removalId !== null ||
    progress.permissionBlocked ||
    now < progress.nextRetryAt
  )) {
    return null;
  }
  if (!hasBlockedIdentities()) return null;
  const failedSweeps: number = progress?.failedSweeps ?? 0;
  let params: RemoveBlockedMembersParams;
  try {
    params = trackBlockedRemoval({ chatId, probeMembership: true });
  } catch (error: unknown) {
    // 满仓或 id 耗尽必须在 update 内就地降级；抛出去会形成重投/重启循环。
    logger.error(`Failed to queue the blocklist sweep of chat ${chatId}:`, error);
    noteSweepAttemptFailed(chatId, failedSweeps, now);
    return null;
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
  return { chatId, params, failedSweeps, now };
}

/** 把已登记的多群补扫合成一次 durable outbox flush 与 Worker 投递。 */
async function deliverPreparedSweeps(
  sweeps: readonly PreparedBlocklistSweep[]
): Promise<void> {
  if (sweeps.length === 0) return;
  try {
    await blockedMemberRemoverHolder.current(
      sweeps.map((sweep: PreparedBlocklistSweep): RemoveBlockedMembersParams =>
        sweep.params
      )
    );
  } catch (error: unknown) {
    for (const sweep of sweeps) {
      // 回执可能抢先到达；只有这批仍是当前 claim 时才写回失败，避免踩掉 sweptAt。
      if (
        blocklistSweepState.get(sweep.chatId)?.removalId ===
        sweep.params.removalId
      ) {
        recordPendingRemovalFailure(
          sweep.params.removalId,
          sweep.chatId,
          "delivery-boundary"
        );
        // 这批任务不会再有回执来推进退避（claim 已清空，迟到的回执走
        // requestBlocklistResweep 那条不动计数的路），因此必须在这里推进。
        noteSweepAttemptFailed(
          sweep.chatId,
          sweep.failedSweeps,
          sweep.now
        );
      }
    }
    throw error;
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
  const sweep: PreparedBlocklistSweep | null =
    prepareBlocklistSweep(chatId, now);
  if (sweep === null) return;
  await deliverPreparedSweeps([sweep]);
}

/**
 * 启动时补扫所有已 /init 且机器人管理员身份已确证的群。多群任务一次性交给
 * durable 投递边界，避免逐群重写不断增长的 outbox；恢复出的在途 claim 会早退。
 */
export async function sweepManagedBlocklistChats(
  now: number = Date.now()
): Promise<void> {
  if (!hasBlockedIdentities()) return;
  const sweeps: PreparedBlocklistSweep[] = [];
  for (const [chatId, state] of getAllChatStates()) {
    const chatState: ChatState = state;
    if (
      chatState.isInitEnabled !== true ||
      chatState.botIsAdmin !== true
    ) {
      continue;
    }
    const sweep: PreparedBlocklistSweep | null =
      prepareBlocklistSweep(chatId, now);
    if (sweep !== null) sweeps.push(sweep);
  }
  await deliverPreparedSweeps(sweeps);
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

function replayPendingBlockedRemovalsForChat(chatId: number): void {
  const removals: RemoveBlockedMembersParams[] = [];
  for (const pending of pendingBlockedRemovals.values()) {
    if (
      pending.params.chatId !== chatId ||
      pending.params.probeMembership
    ) {
      continue;
    }
    const params: RemoveBlockedMembersParams | undefined =
      materializeRemovalParams(pending.params);
    if (params !== undefined) removals.push(params);
  }
  if (removals.length === 0) return;
  void blockedMemberRemoverHolder.current(removals).catch(
    (error: unknown): void => {
      logger.error(
        `Failed to replay ${removals.length} permission-blocked removal batch(es) for chat ${chatId}:`,
        error
      );
    }
  );
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
