/**
 * 黑名单补扫的主线程状态机：退避、权限闩锁、回执结算与 Worker 重建重放。
 *
 * durable 任务的编号、裁剪和 write-ahead 由 outbox.ts 持有；本模块只修改
 * blocklistSweepState 与任务诊断字段，并通过 outbox owner 合并完整快照。
 * @see ../../../docs/cn/04-invariants.md
 */

import {
  blockedMemberRemoverHolder,
  blocklistSweepPages,
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
 * 记下缺封禁权限，并把对应 outbox 批次标成 missing-permission；标记变化时同步排入
 * durable outbox 快照，重启后由 hydrateBlocklist 恢复闩锁。没有既有 sweep
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
    // claim 一律释放，不沿用闩锁期间记下的 removalId：该 id 对应的批次在闩锁期间
    // 被 replayPendingBlockedRemovals 跳过，不会再收到回执。下面的重投只覆盖
    // frozen 批次，probeMembership 补扫由新一轮重新登记。
    removalId: null,
    sweptAt: null,
    nextRetryAt: Date.now(),
    resweepRequested: false,
    failedSweeps: 0,
    permissionBlocked: false,
  });
  armBlocklistSweepScheduler();
  // frozen 秒踢/广告批次各自还带着独立 removalId，新的全名单补扫不会替它们
  // 回执销账。权限边沿到达时先整批重新交给 Worker，让各批按自己的 complete
  // 回执收敛；随后 recordBotChatPermissions 仍会调用 sweepBlockedMembers，覆盖
  // `/block` 直接封禁失败但从未建立 frozen pending 的成员。
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
  // 读盘期间状态可能已经变化（新 claim 落地、权限闩锁置真、`/block disable` 清空名单），
  // 因此调用方在 await 之前的同口径预判不能替代这一次复查。
  if (!canClaimSweep(progress, now)) return null;
  if (!hasAnyBlockedIdentity()) return null;
  const failedSweeps: number = progress?.failedSweeps ?? 0;
  let params: RemoveBlockedMembersParams;
  try {
    params = trackBlockedRemoval({ chatId, probeMembership: true }, page.ids);
  } catch (error: unknown) {
    // 满仓或 id 耗尽在这里就地降级，不向上抛出以避免重投/重启循环。
    logger.error(`Failed to queue the blocklist sweep of chat ${chatId}:`, error);
    noteSweepAttemptFailed(chatId, failedSweeps, now);
    return null;
  }
  // 先成功登记新任务，再删旧任务，避免登记异常时把唯一恢复依据提前销掉。
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
 * 抛错与「正常 resolve 但一条都没投出去」共用同一套善后——对这个群来说两者
 * 后果完全一样：没有消息在途，也就永远等不到 blockedMembersRemoved 回执。
 */
function abandonPreparedSweeps(sweeps: readonly PreparedBlocklistSweep[]): void {
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
      blocklistSweepPages.delete(sweep.params.removalId);
      // 这批任务不会再有回执来推进退避（claim 已清空，迟到的回执走
      // requestBlocklistResweep 那条不动计数的路），因此必须在这里推进。
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
  // 正常 resolve 不等于已投出：并发 `/block disable` 在
  // BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS 轮内持续改动 outbox 时，durable 对账
  // （antiRaid/blocklistDelivery.ts）会把整批 removeBlockedMembers 扣下，纯补扫
  // 批次投递因此以空数组早退并正常 resolve，仍需按失败处理。
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
  // 名单读取跨线程 request/reply（infra/diskIO/host.ts），超时或 Worker 拒收会
  // reject；必须留在 try 内，否则 reject 会跳过 finally 里的 armBlocklistSweepScheduler()。
  try {
    // canClaimSweep 判定不通过时提前返回，避免付出一次不必要的名单页读：
    // readBlocklistSweepPage 会先触发 Disk I/O Worker 的全领域 flush（不看各领域
    // 攒批阈值，见 infra/identityStorage/sweep.ts 与 workers/diskIOWorker.ts 的
    // flushAll），再跨线程取一页主键。判据与 prepareBlocklistSweep 同源，下方仍会
    // 复查一次。
    if (!canClaimSweep(blocklistSweepState.get(chatId), now)) return;
    const page: BlocklistIdPage = hasAnyBlockedIdentity()
      ? await readBlocklistSweepPage(null)
      : { ids: [], nextCursor: null, done: true };
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
 * 名单读不出来时，把这一轮本来该扫的群按「这一轮没成」记账并推进退避，避免
 * `armBlocklistSweepScheduler` 按已过期的 nextRetryAt 立刻重排造成忙等重试。
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
 * 启动时补扫所有已 /init 且机器人管理员身份已确证的群。多群任务一次性交给
 * durable 投递边界，避免逐群重写不断增长的 outbox；恢复出的在途 claim 会早退。
 */
export async function sweepManagedBlocklistChats(
  now: number = Date.now()
): Promise<void> {
  try {
    if (!hasAnyBlockedIdentity()) return;
    // 与 sweepBlockedMembers 同一道闸：一个群都扫不动时不付那次全领域 flush 加
    // 分页读。下面的逐群循环仍照旧遍历整张表，因此读盘期间新变得可扫的群依然
    // 会被这一轮带上。
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
 * 任一步失败都释放 claim、推进退避并保留 outbox；下一轮从空游标安全重放。
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
 * Worker 回执：complete 才销 durable 镜像并允许 sweptAt 落地；未落定任务永久
 * 留在 outbox，直到完成或权威状态取消。
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
    // 上一页已经落定、下一页仍在 read/flush 时收到的重复回执不得把整轮提前销账。
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
    // notePermissionBlocked 可能刚置真，不能在同一回执收尾时覆盖。
    permissionBlocked: blocklistSweepState.get(event.chatId)?.permissionBlocked === true,
  });
  armBlocklistSweepScheduler();
}
