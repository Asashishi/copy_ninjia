/**
 * /block 黑名单的主线程侧入口：一份内存 Map 负责「这个人在不在名单里」的
 * 同步判定，落盘交给唯一的 Disk I/O Worker 追加写 config/blocklist.json
 * （见 workers/diskIO/blocklistFile.ts）。
 *
 * 判定必须是同步的：入群更新到达时要立刻决定踢不踢，不能等一次跨线程往返
 * ——那段延迟里被拉黑的人已经可以在群里发言了。因此磁盘只在启动时读一次，
 * 此后内存 Map 是唯一事实源，写是「先更新 Map、再投递落盘」的单向同步。
 *
 * 本模块自己不打任何 Telegram API：踢人是入群守卫线程的活儿，经
 * blockedMemberRemoverHolder 这个单槽位反向注册分发（同 infra/chatTeardown.ts
 * 的做法），infra 因此不静态依赖 Anti-Raid 业务模块。
 * @see ../../docs/04-invariants.md
 */

import {
  blockedMemberRemoverHolder,
  blockedUserIds,
  blocklistRemovalCounter,
  blocklistSweepState,
  clearBlocklistSweepState,
  pendingBlockedRemovals,
  sessionBlockedAt,
  sessionUnblockedIds,
  type BlocklistSweepRecord,
} from "../cache/blocklist";
import { flushDiskIODomain, lastFailedDiskIODomains, onDiskIORespawn, postDiskIO } from "./diskIO";
import { logger } from "./logger";
import { getAllChatStates } from "./storage/stateStore";
import { formatTokyoTime } from "../libs/time";
import {
  BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS,
  BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES,
  BLOCKLIST_SWEEP_RETRY_INTERVAL_MS,
  BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS,
} from "../consts/antiRaid/blocklist";
import type {
  BlockedMemberRemover,
  BlocklistRemovalFailure,
  PendingBlockedRemoval,
  RemoveBlockedMembersParams,
} from "../types/blocklist";
import type { BlockedMembersRemovedEvent } from "../types/antiRaid";
import type { ChatState } from "../types/chatState";
import type {
  BlocklistRemovalsDiskMessage,
  BlockUserDiskMessage,
  BlockedUserRecord,
  DiskIODomain,
  UnblockUserDiskMessage,
} from "../types/diskIO";
import type { FlushResult } from "../types/lifecycle";

/**
 * 启动恢复：把 diskIOWorker 读回的黑名单整份灌入内存 Map。必须在 runner
 * 开始投喂更新之前完成（见 app/lifecycle.ts），否则启动瞬间进群的黑名单
 * 用户会漏踢。
 */
export function hydrateBlocklist(
  blocked: Map<number, BlockedUserRecord>,
  recoveredRemovals: Map<number, PendingBlockedRemoval> = new Map()
): void {
  blockedUserIds.clear();
  sessionBlockedAt.clear();
  sessionUnblockedIds.clear();
  pendingBlockedRemovals.clear();
  blocklistRemovalCounter.current = 0;
  // 整条记录灌进来，不降级成 true：/unblock 要把这份 Map 整份重写回文件。
  for (const [userId, record] of blocked) blockedUserIds.set(userId, { ...record });
  let filtered: boolean = false;
  for (const [removalId, pending] of recoveredRemovals) {
    blocklistRemovalCounter.current = Math.max(blocklistRemovalCounter.current, removalId);
    const state: ChatState | undefined = getAllChatStates().get(pending.params.chatId);
    const userIds: number[] = pending.params.userIds.filter(
      (userId: number): boolean => blockedUserIds.has(userId)
    );
    if (
      state?.isInitEnabled !== true ||
      state.botIsAdmin !== true ||
      userIds.length === 0
    ) {
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
  }
  if (filtered && !queuePendingBlockedRemovalsSnapshot()) {
    logger.error("Failed to queue the filtered blocklist removal outbox after startup recovery.");
  }
}

/** 把主线程权威镜像完整投给 Disk I/O Worker；写入端会立即原子替换。 */
function queuePendingBlockedRemovalsSnapshot(): boolean {
  return postDiskIO({
    type: "blocklistRemovals",
    removals: [...pendingBlockedRemovals].map(
      ([removalId, pending]: [number, PendingBlockedRemoval]): [number, PendingBlockedRemoval] => [
        removalId,
        {
          params: { ...pending.params, userIds: [...pending.params.userIds] },
          createdAt: pending.createdAt,
          attempts: pending.attempts,
          lastFailure: pending.lastFailure,
        },
      ]
    ),
  } satisfies BlocklistRemovalsDiskMessage);
}

/**
 * Anti-Raid 投递前的 write-ahead 边界：本次任务必须先进入 outbox 且由同一次
 * blocklist 领域 flush 确认，随后才允许消息进入业务 Worker。
 */
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
 * 读取仍由主线程权威镜像持有的处置参数。返回副本，供 Anti-Raid 在 write-ahead
 * flush 前后重新对账；期间若 `/unblock` 或停管已经取消/裁剪任务，旧消息不得
 * 再进入 Worker。
 */
export function getPendingBlockedRemovalParams(
  removalId: number
): RemoveBlockedMembersParams | undefined {
  const pending: PendingBlockedRemoval | undefined = pendingBlockedRemovals.get(removalId);
  if (pending === undefined) return undefined;
  return {
    ...pending.params,
    userIds: [...pending.params.userIds],
  };
}

/** 该用户/频道身份是否在黑名单里。入群秒踢与 /block 去重都走这一条。 */
export function isUserBlocked(userId: number): boolean {
  return blockedUserIds.has(userId);
}

/**
 * 拉黑一个 id：先写内存 Map，再投递落盘消息——顺序不能反。反过来的话，两步
 * 之间到达的入群更新会查到一个还没记上的黑名单，那个人就这么进来了。
 * @returns 本次真的新增了记录为 true；已经在名单里为 false（不重复落盘）。
 */
export function blockUser(userId: number): boolean {
  if (blockedUserIds.has(userId)) return false;
  const blockedAt: string = formatTokyoTime(Date.now());
  blockedUserIds.set(userId, { isBlocked: true, blockedAt });
  sessionBlockedAt.set(userId, blockedAt);
  // 本进程内先解除又重新拉黑：两张 session 表互斥，否则 Worker 重建后的
  // 重放顺序会决定这个人到底在不在名单里。
  sessionUnblockedIds.delete(userId);
  // 投递失败（落盘 Worker 已彻底不可用）不回滚内存：本进程内这个人照样被拦住，
  // 回滚只会让他立刻能进群。但重启后这条记录就没了，必须留下可排查的记录。
  if (!postDiskIO({ type: "blockUser", userId, blockedAt } satisfies BlockUserDiskMessage)) {
    logger.error(`Failed to queue blocklist entry for user ${userId}; it is in memory only and will be lost on restart.`);
  }
  return true;
}

/**
 * 等这一次拉黑真正落盘。postDiskIO 只保证消息进了 Worker 的信箱；写盘失败
 * （config/ 只读、磁盘满、部署后属主不对）在 Worker 内部只有 console.error，
 * 而按本仓库的设计那条日志不会进 logs/，管理员那边看到的仍是「永久拉黑成功」。
 * /block 低频且关键，值得为它等一次统一 flush 回执再措辞。
 * @returns 已 durable 为 true；false 表示这条记录目前只活在内存里，重启就没了。
 */
export async function confirmBlocklistPersisted(): Promise<boolean> {
  // 只看黑名单这一个领域：统一 flush 是七个领域的合取，某群 AI 记忆快照写不
  // 进去也会让这里报「小本本没能写进硬盘」，把运维引向一个其实没坏的文件。
  const result: FlushResult = await flushDiskIODomain("blocklist");
  if (result === "flushed") return true;
  const failedDomains: readonly DiskIODomain[] = lastFailedDiskIODomains();
  // 带上真正坏掉的领域名：Worker 侧的写盘错误按设计只有 console.error，
  // 不在这里点名就没有任何一条进得了 logs/。
  const domainNote: string = failedDomains.length > 0 ? ` failed domains: ${failedDomains.join(", ")}.` : "";
  logger.error(`Blocklist entry was not persisted to disk: flush ${result}.${domainNote}`);
  return false;
}

/**
 * 重复 /block 时的落盘补投：这个 id 已经在内存 Map 里，但如果它是本进程新增
 * 的（在 sessionBlockedAt 里），上一次的落盘可能压根没成功。管理员修好磁盘
 * 再跑一次 /block 是最自然的重试动作，不能因为「Map 里已经有了」就静默跳过
 * ——那会连着两次都告诉他成功了，而文件里根本没有这条记录。
 * @returns 本次补投了落盘消息、调用方应重新等一次确认为 true。
 */
export function ensureBlocklistEntryQueued(userId: number): boolean {
  const blockedAt: string | undefined = sessionBlockedAt.get(userId);
  // 不在 sessionBlockedAt 里 = 启动时从文件 hydrate 进来的，本来就在磁盘上。
  if (blockedAt === undefined) return false;
  if (!postDiskIO({ type: "blockUser", userId, blockedAt } satisfies BlockUserDiskMessage)) {
    logger.error(`Failed to re-queue blocklist entry for user ${userId}; it is in memory only and will be lost on restart.`);
  }
  return true;
}

/**
 * 解除拉黑：先从内存 Map 删掉这个 id，再把**删除之后的整份 Map** 投给落盘
 * Worker 整文件重写。
 *
 * 只能整份重写：黑名单文件是追加型的（见 workers/diskIO/blocklistFile.ts），
 * 没有「删掉一条」这种写法，而写 `isBlocked: false` 墓碑会让启动恢复的严格
 * 校验拒绝整个文件。顺序仍是「先内存、后磁盘」——反过来的话，两步之间到达
 * 的入群更新会查到一个还没解除的名单，那个人白白被踢一次。
 *
 * 同时清掉这个 id 在途的处置批次：不清的话，Worker 重建后的重放会拿着一份
 * 含他的旧批次把刚解除的人重新封掉。已经投出去、正在 Worker 里跑的那一批
 * 拦不住（判定是主线程状态，Worker 没有副本），那一小段窗口里他仍可能被封
 * ——补一次 /unblock 之外，管理员还需要手动解封，见 docs/04-invariants.md。
 * @returns 本次真的移除了记录为 true；本来就不在名单里为 false。
 */
export function unblockUser(userId: number): boolean {
  if (!blockedUserIds.delete(userId)) return false;
  sessionBlockedAt.delete(userId);
  sessionUnblockedIds.add(userId);
  forgetUserBlocklistRemovals(userId);
  if (!postDiskIO({
    type: "unblockUser",
    userId,
    blocked: [...blockedUserIds],
  } satisfies UnblockUserDiskMessage)) {
    logger.error(`Failed to queue blocklist removal for user ${userId}; the entry is still on disk and will come back on restart.`);
  }
  return true;
}

/** 把某个 id 从所有在途批次里摘掉；批次因此变空就整批销账。 */
function forgetUserBlocklistRemovals(userId: number): void {
  let changed: boolean = false;
  for (const [removalId, pending] of pendingBlockedRemovals) {
    if (!pending.params.userIds.includes(userId)) continue;
    const remaining: number[] = pending.params.userIds.filter((id: number): boolean => id !== userId);
    if (remaining.length === 0) pendingBlockedRemovals.delete(removalId);
    else pendingBlockedRemovals.set(removalId, { ...pending, params: { ...pending.params, userIds: remaining } });
    changed = true;
  }
  if (changed && !queuePendingBlockedRemovalsSnapshot()) {
    logger.error(`Failed to queue blocklist removal outbox cleanup for unblocked user ${userId}.`);
  }
}

/** 上层 owner 反向注册黑名单处置的执行者；本叶子模块不静态依赖业务领域。 */
export function registerBlockedMemberRemover(remover: BlockedMemberRemover): void {
  blockedMemberRemoverHolder.current = remover;
}

/**
 * 给一批处置编号并登记镜像。处置是纯副作用、没有状态机，Worker 崩溃就随
 * isolate 一起没了；镜像是它唯一的重放依据（见 cache/blocklist.ts）。
 */
export function trackBlockedRemoval(params: Omit<RemoveBlockedMembersParams, "removalId">): RemoveBlockedMembersParams {
  if (pendingBlockedRemovals.size >= BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
    throw new Error(
      `Blocklist removal outbox reached its ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES}-entry capacity.`
    );
  }
  if (!Number.isSafeInteger(blocklistRemovalCounter.current + 1)) {
    throw new Error("Blocklist removal id space is exhausted.");
  }
  blocklistRemovalCounter.current++;
  const tracked: RemoveBlockedMembersParams = {
    ...params,
    userIds: [...new Set(params.userIds)],
    removalId: blocklistRemovalCounter.current,
  };
  pendingBlockedRemovals.set(tracked.removalId, {
    params: tracked,
    createdAt: Date.now(),
    attempts: 0,
    lastFailure: null,
  });
  return tracked;
}

/**
 * 群不再由本机器人看管（/init disable、被撤管理员、被移出群）：连同在途批次
 * 一起丢弃，而不只是清补扫进度。
 *
 * 只清进度是不够的：被中断的批次会留在镜像里，Anti-Raid Worker 重建后由
 * replayPendingBlockedRemovals 原样重投，而新 isolate 的处置世代表是空的
 * （见 cache/antiRaid/blocklist.ts），Worker 侧那道「停管即整批放弃」的守卫
 * 首末两次都读到 0，根本拦不住——机器人会在一个已经放手的群里继续封人。
 * 停管是主线程的权威判定，Worker 侧的世代只活在 isolate 里，不能当守门人。
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

/**
 * 让这个群重新欠一次补扫，打开 sweptAt 那道闩锁。
 *
 * 用在「这个群里还留着黑名单成员」的信号上：`/block` 在某个群 banChatMember
 * 失败、或秒踢批次没落定。没有它，扫过一次的群里那个人就待到进程结束——
 * 秒踢只对之后的入群更新生效，补扫又被闩锁挡住。
 *
 * 有批次在途时不直接改 sweptAt，改记 resweepRequested：那批的回执可能晚于
 * 本次请求到达，`complete: true` 会把 sweptAt 写回去，请求就丢了。
 * 从没有过补扫记录的群直接返回——它本来就欠着一次，下一次身份观测会扫。
 * @param nextRetryAt 最早允许重扫的时刻，缺省立即。
 */
export function requestBlocklistResweep(chatId: number, nextRetryAt: number = Date.now()): void {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  if (progress === undefined) return;
  blocklistSweepState.set(chatId, {
    removalId: progress.removalId,
    sweptAt: null,
    nextRetryAt,
    resweepRequested: progress.removalId !== null,
    failedSweeps: progress.failedSweeps,
  });
}

/**
 * 这个群下一次允许重扫要等多久：按连续失败次数线性放大，顶到
 * BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS 为止。
 *
 * 固定间隔兜不住「永远封不掉」的目标：目标自己就是这个群的管理员、或机器人是
 * 管理员却没有封禁权限时，每一轮补扫都注定 `complete: false`，于是每个退避窗口
 * 末尾都要重扫一次整份名单——O(名单长度) 次探测 + 封禁，且与验证超时踢人共用
 * joinVerificationApi 队列，正常的踢人请求会被永久顶在后面。
 * 上限不能去掉：`sweptAt` 那道闩锁必须始终有打开的路径，权限修好之后不能等到
 * 进程重启才重扫（见 docs/04-invariants.md）。
 */
function sweepRetryDelayMs(failedSweeps: number): number {
  return Math.min(
    BLOCKLIST_SWEEP_RETRY_INTERVAL_MS * (failedSweeps + 1),
    BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS
  );
}

/** 退避已经顶到上限后不再自增：这个计数只用于算延迟，没必要无界增长。 */
function nextFailedSweeps(failedSweeps: number): number {
  return sweepRetryDelayMs(failedSweeps) >= BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS
    ? failedSweeps
    : failedSweeps + 1;
}

/** 丢掉该群上一轮没落定的补扫批次；新一轮的名单快照是它的超集。 */
function forgetChatSweepBatches(chatId: number): void {
  let changed: boolean = false;
  for (const [removalId, pending] of pendingBlockedRemovals) {
    if (pending.params.chatId === chatId && pending.params.probeMembership) {
      pendingBlockedRemovals.delete(removalId);
      changed = true;
    }
  }
  if (changed && !queuePendingBlockedRemovalsSnapshot()) {
    logger.error(`Failed to queue superseded blocklist sweep cleanup for chat ${chatId}.`);
  }
}

/**
 * 把黑名单里此刻已经在某个群里的人全部清出去。用在「机器人在这个群可以干活
 * 了」这个合取（是管理员 && 已 /init enable）成立的时候（见 infra/botAdmin.ts）：
 * 拉黑发生时机器人在这个群还没有权限，那次 /block 的连坐封禁跳过了它；入群
 * 秒踢也只对之后的入群更新生效，对早就坐在群里的人无能为力。
 *
 * 这里只做「取名单快照 + 交给执行 owner」。Bot API 没有「列出群成员」这种
 * 接口，逐个探成员身份那 O(名单长度) 次请求全部发生在入群守卫线程里
 * （见 workers/antiRaid/blocklistEffects.ts），既走 joinVerificationApi 队列，
 * 也不占主线程处理 update 的时间。名单为空时连消息都不投。
 *
 * 「这个群扫过了没有」由 blocklistSweepState 记账，而不是由调用方那边的
 * 身份变更边沿代表：只有 Worker 回执说全部落定才算扫过。调用方可以放心地
 * 每次观测到管理员身份都调一次，重复与退避都在这里收敛。
 */
export async function sweepBlockedMembers(chatId: number, now: number = Date.now()): Promise<void> {
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(chatId);
  // 已经完整扫过、有批次在途、或上次没扫完还在退避窗口里：都不重投。这道
  // 判断必须排在取名单快照之前——调用方每观测到一次管理员身份就会来问一次，
  // 而那是每条入群更新都会发生的事，不能每次都把整份名单拷一遍。
  if (progress !== undefined && (progress.sweptAt !== null || progress.removalId !== null || now < progress.nextRetryAt)) {
    return;
  }
  const userIds: number[] = [...blockedUserIds.keys()];
  if (userIds.length === 0) return;
  // 上一轮没落定的补扫批次由这一批完整取代：名单只增不减，新快照是它的超集。
  // 不删的话每次退避重试都在镜像里沉积一份完整 userIds 副本，且每次 Worker
  // 重建都把这些副本全部重投一遍。
  forgetChatSweepBatches(chatId);
  const failedSweeps: number = progress?.failedSweeps ?? 0;
  const params: RemoveBlockedMembersParams = trackBlockedRemoval({ chatId, userIds, probeMembership: true });
  blocklistSweepState.set(chatId, {
    removalId: params.removalId,
    sweptAt: null,
    nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
    resweepRequested: false,
    failedSweeps,
  });
  try {
    await blockedMemberRemoverHolder.current([params]);
  } catch (error: unknown) {
    // 无论 Worker 是没收到、屏障失败还是副作用没落定，durable outbox 都保留
    // 这批任务。update 会因本次异常重投，但 outbox 是独立恢复边界；依赖重投
    // 来代替它会在 Telegram 不再提供旧 update 时重新制造丢任务窗口。
    // 回执可能已经抢先到达——Worker 收下后同步派发完，主线程还卡在落盘屏障
    // 上。只有这批仍是当前在途批次时才回写，否则会踩掉它写下的 sweptAt。
    if (blocklistSweepState.get(chatId)?.removalId === params.removalId) {
      recordPendingRemovalFailure(params.removalId, chatId, "delivery-boundary");
      blocklistSweepState.set(chatId, {
        removalId: null,
        sweptAt: null,
        nextRetryAt: now + sweepRetryDelayMs(failedSweeps),
        resweepRequested: false,
        failedSweeps,
      });
    }
    throw error;
  }
}

/**
 * Worker 回执：这批处置走完了。complete 才销镜像并把群记成已扫过——没落定
 * 的批次永久留着等重投，只有完成或权威状态失效才能销账。
 */
export function settleBlockedRemoval(event: BlockedMembersRemovedEvent): void {
  if (event.complete) {
    if (
      pendingBlockedRemovals.delete(event.removalId) &&
      !queuePendingBlockedRemovalsSnapshot()
    ) {
      logger.error(`Failed to queue completed blocklist removal cleanup ${event.removalId}.`);
    }
  } else {
    // 「未落定」必须留下记录，且要排在下面的 removalId 对账之前：秒踢那一路
    // 的批次跟补扫进度对不上，会提前返回。而黑名单入群不开验证窗口、没有超时
    // 踢人兜底，这批失败就是那个人留在群里的全部原因——logs/ 里不能一个字都
    // 没有。
    logger.error(`Blocklist removal ${event.removalId} for chat ${event.chatId} did not fully settle; it will be retried.`);
    recordPendingRemovalFailure(event.removalId, event.chatId, "side-effect-incomplete");
  }
  const progress: BlocklistSweepRecord | undefined = blocklistSweepState.get(event.chatId);
  if (progress?.removalId !== event.removalId) {
    // 秒踢那一路的回执不动补扫进度，但没落定时要让这个群重新欠一次清扫——
    // 补扫是那个人被清出去的下一次机会，不能只指望 Worker 恰好崩溃。带退避是
    // 因为黑名单账号可能反复回流，每次失败都立刻触发 O(名单长度) 次成员探测
    // 就是一场请求风暴；退避按这个群连续失败的补扫次数放大，否则一个永远封不
    // 掉的目标会把「秒踢失败 → 重扫 → 重扫也失败」这个环固定在 5 分钟一轮。
    if (!event.complete) {
      requestBlocklistResweep(
        event.chatId,
        Date.now() + sweepRetryDelayMs(progress?.failedSweeps ?? 0)
      );
    }
    return;
  }
  // 在途期间有人请求过重扫（比如 /block 在这个群封禁失败）：哪怕这批回执说
  // 全部落定，也不能把 sweptAt 写下去——那个请求正是冲着「这个群里还留着人」
  // 来的。nextRetryAt 原样保留：请求方已经把「最早什么时候能重扫」写进去了。
  // 没落定只累计失败次数，退避的放大留到下一次真正投递时按它换算（见
  // sweepBlockedMembers）：连续失败的群于是按 5、10、15…分钟逐次拉开，而不是
  // 永远 5 分钟一轮地重扫整份名单。落定则清零，权限恢复后立刻回到正常节奏。
  const failedSweeps: number = event.complete ? 0 : nextFailedSweeps(progress.failedSweeps);
  blocklistSweepState.set(event.chatId, {
    removalId: null,
    sweptAt: event.complete && !progress.resweepRequested ? Date.now() : null,
    nextRetryAt: progress.nextRetryAt,
    resweepRequested: false,
    failedSweeps,
  });
}

/**
 * 只更新一次「这批没落地」的诊断计数。达到告警阈值只升级日志，不删除
 * durable 任务；调用方负责把一条或一批更新后的完整镜像排队持久化。
 */
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
      `retaining its durable outbox entry until completion or authoritative cancellation.`
    );
  }
  return true;
}

/**
 * 记一次「这批没落地」，并只在跨越告警阈值那一次把整份镜像排队写回。
 *
 * 这里变的只有诊断字段（attempts / lastFailure），任务本身没有增删——因此不能
 * 逐条排完整快照：一轮重放会回来 N 份「没落定」回执，每份都做一次 O(n) 的全表
 * 深拷贝 + 校验 + stringify 加一次整文件 fsync，合起来就是 O(n²)，正是
 * replayPendingBlockedRemovals 注释里点名禁止的形态（N 可以一直涨到
 * BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES）。丢掉中间那些计数只影响诊断精度：
 * 值会由下一次权威快照顺带写回（完成回执、`/unblock`、停管、新批次的
 * write-ahead、Worker 重建重放），而任务本身的 params/createdAt 早在投递前的
 * write-ahead 里就已经 durable。
 * 跨越阈值那一次仍立刻落盘：`达到告警阈值只升级日志、不得删除任务` 这条判断
 * 本身要跨重启存活，否则每次重启都要重新从零累计才会再报警。
 */
function recordPendingRemovalFailure(
  removalId: number,
  chatId: number,
  failure: BlocklistRemovalFailure
): void {
  if (!updatePendingRemovalFailure(removalId, chatId, failure)) return;
  if (pendingBlockedRemovals.get(removalId)?.attempts !== BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS) return;
  if (!queuePendingBlockedRemovalsSnapshot()) {
    logger.error(`Failed to queue blocklist removal retry state ${removalId}.`);
  }
}

/**
 * Anti-Raid Worker 重建后重投所有未销账的处置。重复 ban 是幂等的，漏掉却
 * 意味着那个人一直坐在群里——处置没有状态机，重放是它唯一的存活方式。
 * 带着这批一起崩溃也算一次「没落地」，同样累计诊断计数；整批更新由下方
 * dispatcher 的 write-ahead 一次持久化，不能逐条排完整快照形成 O(n²)。
 */
export function replayPendingBlockedRemovals(countPreviousAttempt: boolean = true): void {
  const removals: RemoveBlockedMembersParams[] = [];
  for (const [removalId, pending] of [...pendingBlockedRemovals]) {
    if (countPreviousAttempt) {
      updatePendingRemovalFailure(removalId, pending.params.chatId, "worker-restarted");
    }
    removals.push(pending.params);
  }
  if (removals.length === 0) return;
  void blockedMemberRemoverHolder.current(removals).catch((error: unknown): void => {
    logger.error(`Failed to replay ${removals.length} blocklist removal batch(es):`, error);
  });
}

// diskIOWorker 崩溃重建后补齐本进程期间的增量：新 Worker 已从文件 hydrate 过，
// 早就落盘的 id 会被它按已知 id 跳过，这里整批重投是幂等的（见 cache/blocklist.ts）。
onDiskIORespawn((): void => {
  if (!queuePendingBlockedRemovalsSnapshot()) {
    logger.error("Failed to replay the blocklist removal outbox after persistence Worker recovery.");
  }
  // 本进程内解除过拉黑：新 Worker 读回的文件里那些条目还在，而追加补不回
  // 「删除」。只能整份重写一次——它同时覆盖了本进程新增的那些，不必再逐条
  // 追加。代价是一次 O(名单长度) 的写，而 Worker 重建本来就很罕见。
  if (sessionUnblockedIds.size > 0) {
    postDiskIO({ type: "unblockUser", blocked: [...blockedUserIds] } satisfies UnblockUserDiskMessage);
    return;
  }
  for (const [userId, blockedAt] of sessionBlockedAt) {
    postDiskIO({ type: "blockUser", userId, blockedAt } satisfies BlockUserDiskMessage);
  }
});
