/**
 * 黑名单补扫的主线程状态机：退避、权限闩锁、回执结算与 Worker 重建重放。
 *
 * durable 任务的编号、裁剪和 write-ahead 由 outbox.ts 持有；本模块修改
 * blocklistSweepState、blocklistSweepPages 与任务诊断字段，并通过 outbox.ts 合并完整快照。
 * @see ../../../docs/cn/04-invariants.md
 */

import {
  blockedMemberRemoverHolder,
  blocklistSweepPages,
  blocklistSweepSchedulerState,
  blocklistSweepState,
  pendingBlockedRemovals,
} from "../../cache/main/blocklist";
import { logger } from "../logger";
import { getChatStateCache } from "../storage/stateStore";
import {
  hasAnyBlockedIdentity,
  readBlocklistSweepPage,
} from "../identityStorage";
import {
  armBlocklistSweepScheduler,
  initBlocklistSweepScheduler as initSweepScheduler,
} from "./sweepScheduler";
import { canClaimSweep, isManagedAdminChat } from "./sweepEligibility";
import {
  forgetSupersededChatSweepBatches,
  materializeRemovalParams,
  queuePendingBlockedRemovalsSnapshot,
  trackBlockedRemoval,
} from "./outbox";
import type { BlockedMembersRemovedEvent } from
  "../../types/antiRaid/events";
import type {
  BlocklistSweepPageState,
  BlocklistSweepRecord,
  PendingBlockedRemoval,
  RemoveBlockedMembersParams,
} from "../../types/blocklist";
import type { ChatState } from "../../types/chatState";
import type { BlocklistIdPage } from "../../types/identityStorage";
import {
  nextFailedSweeps,
  noteSweepAttemptFailed,
  recordPendingRemovalFailure,
  requestBlocklistResweep,
  sweepRetryDelayMs,
} from "./sweepRetryState";
import { replayPendingBlockedRemovalsForChat } from "./sweepReplay";

export { requestBlocklistResweep } from "./sweepRetryState";
export { replayPendingBlockedRemovals } from "./sweepReplay";

export { quiesceBlocklistSweepScheduler } from "./sweepScheduler";

const runScheduledBlocklistSweep: () => Promise<void> = (): Promise<void> =>
  sweepManagedBlocklistChats(Date.now());

/** 启动恢复完成后武装补扫时钟；重复初始化只重算最近截止时间。 */
export function initBlocklistSweepScheduler(): void {
  initSweepScheduler(runScheduledBlocklistSweep);
}

/**
 * 记下缺封禁权限并闩住这个群。补扫批次标成 missing-permission 留在 outbox，标记变化时
 * 排入 durable 快照，重启后由 hydrateBlocklist 恢复闩锁；`probeMembership === false` 的
 * 指名批次直接从 pendingBlockedRemovals 销账，权限恢复后由 noteBanPermissionObserved
 * 重新武装的全名单补扫覆盖。没有既有 sweep 记录时建立最小闩锁。
 * 错误日志只在闩锁由未置位变为置位时记一次。
 */
function notePermissionBlocked(chatId: number, removalId: number): void {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress?.permissionBlocked !== true) {
    logger.error(
      `Blocklist removal ${removalId} for chat ${chatId} is blocked by missing ban rights; ` +
      "removals there wait for the bot's permissions to change."
    );
  }
  if (pendingBlockedRemovals.get(removalId)?.params.probeMembership === false) {
    pendingBlockedRemovals.delete(removalId);
    if (!queuePendingBlockedRemovalsSnapshot()) {
      logger.error(`Failed to queue permission-blocked blocklist removal cleanup ${removalId}.`);
    }
  } else {
    recordPendingRemovalFailure(removalId, chatId, "missing-permission");
  }
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
  armBlocklistSweepScheduler();
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
    // claim 一律释放；闩锁期间记下的 removalId 不沿用。下面的重投只覆盖
    // 冻结批次，probeMembership 补扫由新一轮重新登记。
    removalId: null,
    sweptAt: null,
    nextRetryAt: Date.now(),
    resweepRequested: false,
    failedSweeps: 0,
    permissionBlocked: false,
  });
  armBlocklistSweepScheduler();
  // 权限边沿到达时把该群仍在 outbox 的冻结批次整批重新交给 Worker，各批按自己的
  // complete 回执收敛；因缺权限销账的指名批次与 `/block` 直接封禁失败的成员，
  // 由 recordBotChatPermissions 随后调用的 sweepBlockedMembers 覆盖。
  replayPendingBlockedRemovalsForChat(chatId);
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
  now: number,
  page: BlocklistIdPage
): PreparedBlocklistSweep | null {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  // 读盘期间状态可能已变化（新 claim 落地、权限闩锁置真、`/block disable` 清空名单），
  // 这里按同一口径复查 claim 资格。
  if (!canClaimSweep(progress, now)) return null;
  if (!hasAnyBlockedIdentity()) return null;
  const failedSweeps: number = progress?.failedSweeps ?? 0;
  let params: RemoveBlockedMembersParams;
  try {
    params = trackBlockedRemoval({ chatId, probeMembership: true }, page.ids);
  } catch (error: unknown) {
    // outbox 满仓或 id 耗尽时按本轮失败推进退避，不向上抛出。
    logger.error(`Failed to queue the blocklist sweep of chat ${chatId}:`, error);
    noteSweepAttemptFailed(chatId, failedSweeps, now);
    return null;
  }
  // 先登记新任务，再删旧任务。
  forgetSupersededChatSweepBatches(chatId, params.removalId);
  blocklistSweepState.set(chatId, {
    removalId: params.removalId,
    sweptAt: null,
    nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
    resweepRequested: false,
    failedSweeps,
    permissionBlocked: false,
  });
  blocklistSweepPages.set(params.removalId, {
    chatId,
    nextCursor: page.nextCursor,
    done: page.done,
    awaitingAck: true,
  });
  armBlocklistSweepScheduler();
  return { chatId, params, failedSweeps, now };
}

/**
 * 一批补扫没能交出去时的统一记账：作废 claim、记诊断、推进退避。
 * 投递抛错与「正常 resolve 但一条都没投出去」共用这套善后。
 */
function abandonPreparedSweeps(sweeps: readonly PreparedBlocklistSweep[]): void {
  for (const sweep of sweeps) {
    // 只有这批仍是当前 claim 时才写回失败。
    if (
      blocklistSweepState.get(sweep.chatId)?.removalId ===
      sweep.params.removalId
    ) {
      recordPendingRemovalFailure(
        sweep.params.removalId,
        sweep.chatId,
        "delivery-boundary"
      );
      blocklistSweepPages.delete(sweep.params.removalId);
      // 这批任务没有回执推进退避，失败计数在这里推进。
      noteSweepAttemptFailed(
        sweep.chatId,
        sweep.failedSweeps,
        sweep.now
      );
    }
  }
}

/** 把已登记的多群补扫合成一次 durable outbox flush 与 Worker 投递。 */
async function deliverPreparedSweeps(
  sweeps: readonly PreparedBlocklistSweep[]
): Promise<void> {
  if (sweeps.length === 0) return;
  let deliveredCount: number;
  try {
    deliveredCount = await blockedMemberRemoverHolder.current(
      sweeps.map((sweep: PreparedBlocklistSweep): RemoveBlockedMembersParams =>
        sweep.params
      )
    );
  } catch (error: unknown) {
    abandonPreparedSweeps(sweeps);
    throw error;
  }
  if (deliveredCount > 0) return;
  // resolve 且 0 条投出：durable 对账（antiRaid/blocklistDelivery.ts）在
  // BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS 轮内未收敛时扣下整批 removeBlockedMembers，按失败处理。
  abandonPreparedSweeps(sweeps);
  logger.error(
    `Blocklist sweep delivery posted nothing for ${sweeps.length} chat(s); ` +
    "the batches stay in the durable outbox and the sweeps were rescheduled."
  );
}

/**
 * 把当前黑名单在某个已管理群中补扫一遍。只登记 durable 任务并交给执行 owner；
 * 具体名单由 outbox 在投递时现算，全部 Telegram 请求都在 Anti-Raid Worker。
 */
export async function sweepBlockedMembers(
  chatId: number,
  now: number = Date.now()
): Promise<void> {
  // 名单读取是跨线程 request/reply（infra/diskIO/host.ts），超时或 Worker 拒收会
  // reject；读取留在 try 内，finally 恒重排补扫调度器。
  try {
    // canClaimSweep 判定不通过时提前返回，不读名单页：readBlocklistSweepPage
    // 先触发 Disk I/O Worker 的黑名单领域 flush（立即提交共享 SQLite 事务，
    // 不看攒批阈值，见 infra/identityStorage/sweep.ts 与 workers/diskIO/domainFlush.ts
    // 的 flushDomain），再跨线程取一页主键。判据与 prepareBlocklistSweep 同源，
    // prepareBlocklistSweep 内复查。
    if (!canClaimSweep(blocklistSweepState.get(chatId), now)) return;
    let page: BlocklistIdPage;
    try {
      page = hasAnyBlockedIdentity()
        ? await readBlocklistSweepPage(null)
        : { ids: [], nextCursor: null, done: true };
    } catch (error: unknown) {
      // 名单读不出来时按「这一轮没成」推进退避，口径同 deferManagedBlocklistSweeps。
      const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
      if (canClaimSweep(progress, now)) noteSweepAttemptFailed(chatId, progress?.failedSweeps ?? 0, now);
      throw error;
    }
    const sweep: PreparedBlocklistSweep | null = page.ids.length === 0
      ? null
      : prepareBlocklistSweep(chatId, now, page);
    if (sweep === null) return;
    await deliverPreparedSweeps([sweep]);
  } finally {
    armBlocklistSweepScheduler();
  }
}

/**
 * 名单读不出来时，把这一轮本来该扫的群按「这一轮没成」记账并推进退避。
 * 资格判定与 prepareBlocklistSweep 同口径。
 */
function deferManagedBlocklistSweeps(now: number): void {
  for (const [chatId, state] of getChatStateCache()) {
    const chatState: ChatState = state;
    if (!isManagedAdminChat(chatState)) continue;
    const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
    if (!canClaimSweep(progress, now)) continue;
    noteSweepAttemptFailed(chatId, progress?.failedSweeps ?? 0, now);
  }
}

/**
 * 本轮是否至少有一个受管群还能建立 claim，判据与 prepareBlocklistSweep 同源；
 * 只用来决定要不要付出这次名单页读，命中即停。
 */
function hasClaimableManagedChat(now: number): boolean {
  for (const [chatId, state] of getChatStateCache()) {
    const chatState: ChatState = state;
    if (!isManagedAdminChat(chatState)) continue;
    if (canClaimSweep(blocklistSweepState.get(chatId), now)) return true;
  }
  return false;
}

/**
 * 补扫所有已 /init 且机器人管理员身份已确证的群（启动时与定时器到点时调用）。多群任务合并后
 * 一次性交给 durable 投递边界；恢复出的在途 claim 在 prepareBlocklistSweep 内早退。
 */
export async function sweepManagedBlocklistChats(
  now: number = Date.now()
): Promise<void> {
  try {
    if (!hasAnyBlockedIdentity()) return;
    // 与 sweepBlockedMembers 同一道闸：没有可建立 claim 的受管群时不读名单页。
    // 下面的逐群循环遍历整张表，读盘期间变得可扫的群同样带上。
    if (!hasClaimableManagedChat(now)) return;
    let page: BlocklistIdPage;
    try {
      page = await readBlocklistSweepPage(null);
    } catch (error: unknown) {
      logger.error("Failed to read the first blocklist ID page for the managed chat sweep:", error);
      deferManagedBlocklistSweeps(now);
      return;
    }
    if (page.ids.length === 0) return;
    const sweeps: PreparedBlocklistSweep[] = [];
    for (const [chatId, state] of getChatStateCache()) {
      const chatState: ChatState = state;
      if (!isManagedAdminChat(chatState)) continue;
      const sweep: PreparedBlocklistSweep | null =
        prepareBlocklistSweep(chatId, now, page);
      if (sweep !== null) sweeps.push(sweep);
    }
    await deliverPreparedSweeps(sweeps);
  } finally {
    armBlocklistSweepScheduler();
  }
}

/**
 * 上一页完整落定后读取并投递同一 durable 任务的下一页。
 * 任一步失败都释放 claim、推进退避并保留 outbox；下一轮从空游标重放。
 */
async function continueBlocklistSweep(
  chatId: number,
  removalId: number,
  afterId: number
): Promise<void> {
  try {
    const page: BlocklistIdPage = await readBlocklistSweepPage(afterId);
    const progress: BlocklistSweepRecord | undefined =
      blocklistSweepState.get(chatId);
    const pending: PendingBlockedRemoval | undefined =
      pendingBlockedRemovals.get(removalId);
    if (
      progress?.removalId !== removalId ||
      pending?.params.probeMembership !== true
    ) {
      blocklistSweepPages.delete(removalId);
      return;
    }
    if (page.ids.length === 0) {
      blocklistSweepPages.delete(removalId);
      settleBlockedRemoval({
        type: "blockedMembersRemoved",
        chatId,
        removalId,
        complete: true,
        permissionDenied: false,
        targetIsAdmin: false,
        participantInvalidUserIds: [],
        settledUserIds: [],
      });
      return;
    }
    const params: RemoveBlockedMembersParams | undefined =
      materializeRemovalParams(pending.params, page.ids);
    if (params === undefined) {
      throw new Error(`Blocklist sweep page for removal ${removalId} has no target.`);
    }
    blocklistSweepPages.set(removalId, {
      chatId,
      nextCursor: page.nextCursor,
      done: page.done,
      awaitingAck: true,
    });
    await deliverPreparedSweeps([{
      chatId,
      params,
      failedSweeps: progress.failedSweeps,
      now: Date.now(),
    }]);
  } catch (error: unknown) {
    const progress: BlocklistSweepRecord | undefined =
      blocklistSweepState.get(chatId);
    if (progress?.removalId === removalId) {
      recordPendingRemovalFailure(removalId, chatId, "delivery-boundary");
      blocklistSweepPages.delete(removalId);
      noteSweepAttemptFailed(chatId, progress.failedSweeps, Date.now());
    }
    logger.error(
      `Failed to continue blocklist sweep ${removalId} for chat ${chatId}:`,
      error
    );
  }
}

/**
 * Worker 回执：complete 才销 durable 镜像并允许 sweptAt 落地；未落定任务留在
 * outbox，直到完成或权威状态取消，缺封禁权限的指名批次例外（见 notePermissionBlocked）。
 * 任务与补扫记录都已被 forgetChatBlocklistWork 撤销（群不再受管）时，迟到回执直接丢弃。
 */
export function settleBlockedRemoval(event: BlockedMembersRemovedEvent): void {
  const page: BlocklistSweepPageState | undefined =
    blocklistSweepPages.get(event.removalId);
  const currentProgress: BlocklistSweepRecord | undefined =
    blocklistSweepState.get(event.chatId);
  if (
    page !== undefined &&
    currentProgress?.removalId === event.removalId
  ) {
    // awaitingAck 为 false 表示下一页仍在 read/flush，此时收到的重复回执忽略。
    if (!page.awaitingAck) return;
    if (event.complete && !page.done) {
      if (event.targetIsAdmin === true) {
        blocklistSweepState.set(event.chatId, {
          ...currentProgress,
          resweepRequested: true,
        });
      }
      if (page.nextCursor === null) {
        blocklistSweepPages.delete(event.removalId);
        recordPendingRemovalFailure(
          event.removalId,
          event.chatId,
          "delivery-boundary"
        );
        noteSweepAttemptFailed(
          event.chatId,
          currentProgress.failedSweeps,
          Date.now()
        );
        logger.error(
          `Non-final blocklist sweep ${event.removalId} is missing its next cursor.`
        );
        return;
      }
      blocklistSweepPages.set(event.removalId, {
        ...page,
        awaitingAck: false,
      });
      void continueBlocklistSweep(
        event.chatId,
        event.removalId,
        page.nextCursor
      );
      return;
    }
    blocklistSweepPages.delete(event.removalId);
  }
  if (
    !pendingBlockedRemovals.has(event.removalId) &&
    !blocklistSweepState.has(event.chatId)
  ) {
    return;
  }
  if (event.complete) {
    if (
      pendingBlockedRemovals.delete(event.removalId) &&
      !queuePendingBlockedRemovalsSnapshot()
    ) {
      logger.error(`Failed to queue completed blocklist removal cleanup ${event.removalId}.`);
    }
  } else if (event.permissionDenied === true) {
    notePermissionBlocked(event.chatId, event.removalId);
  } else {
    const message: string =
      `Blocklist removal ${event.removalId} for chat ${event.chatId} did not fully settle; ` +
      "it will be retried.";
    // 调度器停止接收后（停机）只记 log，任务留在 outbox 由下次启动续跑。
    if (blocklistSweepSchedulerState.accepting) logger.error(message);
    else logger.log(message);
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
    armBlocklistSweepScheduler();
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
    // 取当前值，保留 notePermissionBlocked 刚置的闩锁。
    permissionBlocked: blocklistSweepState.get(event.chatId)?.permissionBlocked === true,
  });
  armBlocklistSweepScheduler();
}
