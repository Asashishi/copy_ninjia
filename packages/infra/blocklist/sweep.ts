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
  armBlocklistSweepScheduler as armSweepScheduler,
  initBlocklistSweepScheduler as initSweepScheduler,
} from "./sweepScheduler";
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

function armBlocklistSweepScheduler(): void {
  armSweepScheduler();
}

/** 启动恢复完成后武装补扫时钟；重复初始化只重算最近截止时间。 */
export function initBlocklistSweepScheduler(): void {
  initSweepScheduler(runScheduledBlocklistSweep);
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
    // claim 一律释放，不沿用闩锁期间记下的 removalId。那个 id 未必还有对应的
    // 在途任务：闩锁一旦置真，Worker 重建时的 replayPendingBlockedRemovals 就
    // 跳过这个群，被闩住之前投出去的补扫批次没人重投、也永远等不到回执；而下面
    // 那次重投按设计只覆盖 frozen 批次（probeMembership 的补扫由新一轮重新登记）。
    // 继续把它当成有效 claim，等于让 prepareBlocklistSweep 的 removalId !== null
    // 早退永久成立——这个群从此再也补扫不了，群里的黑名单成员一直坐着。
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
  if (progress !== undefined && (
    progress.sweptAt !== null ||
    progress.removalId !== null ||
    progress.permissionBlocked ||
    now < progress.nextRetryAt
  )) {
    return null;
  }
  if (!hasAnyBlockedIdentity()) return null;
  const failedSweeps: number = progress?.failedSweeps ?? 0;
  let params: RemoveBlockedMembersParams;
  try {
    params = trackBlockedRemoval({ chatId, probeMembership: true }, page.ids);
  } catch (error: unknown) {
    // 满仓或 id 耗尽必须在 update 内就地降级；抛出去会形成重投/重启循环。
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
  // 正常 resolve 不等于投出去了：并发 `/unblock` 在
  // BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS 轮内持续改动 outbox 时，durable 对账
  // 会扣下整批 removeBlockedMembers（antiRaid/blocklistDelivery.ts），纯补扫这批
  // 于是只剩空数组，投递路径以 length === 0 早退并正常 resolve。不在这里判失败的
  // 话：claim 里的 removalId 停在原值、诊断不记、退避不推进，而消息从未投出，
  // blockedMembersRemoved 回执永不会来——此后 prepareBlocklistSweep 对这个群永远
  // 在 `removalId !== null` 早退，本进程生命周期内它再也不会被清扫，只能靠整进程
  // 重启走 hydrateBlocklist + replayPendingBlockedRemovals 捞回来。
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
  // 名单读取必须留在 try 里：它已经不是同步本地读，而是跨线程 request/reply，
  // 超时或 Worker 拒收都会 reject（infra/diskIO/host.ts）。落在 try 之外时那次
  // reject 直接跳过 finally，`armBlocklistSweepScheduler()` 本次不执行——典型
  // 路径是 recordBotChatPermissions 在权限恢复时调用本函数而 Disk I/O 正在 recycle，
  // 于是周期性补扫在本进程生命周期内不再被武装。
  try {
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
 * 名单读不出来时，把这一轮本来该扫的群按「这一轮没成」记账并推进退避。
 *
 * 不能让读失败原样抛给调度器：`armBlocklistSweepScheduler` 在 finally 里按早已
 * 过期的 nextRetryAt 立刻重排，Disk I/O 自愈窗口里就是一串 0ms 的忙等重试，每轮
 * 还多一行错误日志。资格判定与 prepareBlocklistSweep 保持同一口径。
 */
function deferManagedBlocklistSweeps(now: number): void {
  for (const [chatId, state] of getChatStateCache()) {
    const chatState: ChatState = state;
    if (
      chatState.isInitEnabled !== true ||
      chatState.botPermissions?.isAdministrator !== true
    ) continue;
    const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
    if (progress !== undefined && (
      progress.sweptAt !== null ||
      progress.removalId !== null ||
      progress.permissionBlocked ||
      now < progress.nextRetryAt
    )) {
      continue;
    }
    noteSweepAttemptFailed(chatId, progress?.failedSweeps ?? 0, now);
  }
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
      if (
        chatState.isInitEnabled !== true ||
        chatState.botPermissions?.isAdministrator !== true
      ) {
        continue;
      }
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
