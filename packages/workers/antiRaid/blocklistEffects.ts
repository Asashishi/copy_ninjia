/**
 * /block 黑名单的处置副作用（入群守卫线程侧）。判定不在这里——名单是主线程
 * 状态，`isUserBlocked` 在主线程同步查完才投递本消息（见 infra/blocklist/
 * 与 antiRaid/blocklistGuard.ts）。本模块负责「把这些 id 清出这个群」这一步：
 * 探测、封禁、失败重试，以及秒踢路径顺带的入群计数与公告清理。
 *
 * 与验证超时踢人一样放在 Worker 里：重试节奏、群停管代际与整批结算都由
 * Anti-Raid owner 维护；每个 Telegram 调用只通过双工能力交给主线程总闸执行，
 * Worker 等待网络时不阻塞 mailbox。
 *
 * 与本线程其它副作用共用同一条节奏：dispatch 里同步的部分立即返回，异步能力
 * 请求事后串行交给主线程执行，不阻塞 mailbox。
 *
 * 三条约束（见 docs/cn/04-invariants.md）：
 * - 失败必须重试，且最终结果要回执给主线程；黑名单入群不开验证窗口，没有
 *   超时踢人兜底。
 * - 探测失败不算「不在群」：只有确认不在群才跳过，其余一律照封。
 * - 群停管后立刻放弃在途批次。
 *
 * 整批登记在 Worker 在途任务集合里、由停机 drain 等待，同时订阅停机取消信号
 * （antiRaidDispatchSignal）：取消后不再开始新的 id、分批暂停或重试退避，整批按
 * complete:false 回执，durable outbox 在下一次启动重放。
 *
 * `permissionDenied` 只能由**机器人自己缺权限**触发；Telegram 用同一句 400 表达
 * 「目标是管理员」，该情形归 RemovalOutcome 的 targetIsAdmin。
 */

import { banChatMemberWithOutcome, banChatSenderChatWithOutcome, deleteMessage, probeChatAdmin, telegramApi } from "../../infra/telegram";
import type { BanChatMemberOutcome } from "../../infra/telegram";
import { probeChatMembershipWithOutcome } from "../../infra/telegram/actions/membership";
import type { ChatMembershipProbeOutcome } from "../../infra/telegram/actions/membership";
import { logger } from "../../infra/logger";
import { botCanDeleteIn, botCanRestrictIn } from "./botPermissions";
import { recordJoin } from "./lockdownRuntime";
import { currentBlocklistRemovalEpoch } from "../../cache/workers/antiRaid/blocklist";
import {
  BLOCKLIST_REMOVAL_MAX_ATTEMPTS,
  BLOCKLIST_REMOVAL_RETRY_DELAY_MS,
  BLOCKLIST_SWEEP_BATCH_PAUSE_MS,
  BLOCKLIST_SWEEP_BATCH_SIZE,
} from "../../consts/antiRaid/blocklist";
import { JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import type { BlockedMembersRemovedEvent } from
  "../../types/antiRaid/events";
import type { RemoveBlockedMembersMessage } from
  "../../types/antiRaid/protocol";
import type { RemoveBlockedMembersParams } from "../../types/blocklist";
import { antiRaidDispatchSignal } from "../../cache/workers/antiRaid/tasks";
import { trackAntiRaidTask } from "./taskTracker";
import { releaseAdDetectDedupKey } from "./adDetect/queueState";
import { sleepUnlessAborted } from "../../libs/sleep";

/**
 * 单个 id 的处置结局。
 *
 * `forbidden`：机器人在这个群封不了人，主线程据此停掉这个群按时间的重试，
 * 只等一次确证的权限变更（见 docs/cn/04-invariants.md）。
 * `targetIsAdmin`：Telegram 对「目标本身是管理员」返回的同样是 400 `not enough rights`，
 * 这一档只结算这个目标，不动群级的 permissionBlocked。
 * `participantInvalid` 与 `failed` 同样算未落定，区别只在回执里把这个 id 报给
 * 主线程的销号计数（见 infra/blocklist/participantInvalid.ts）。
 */
type RemovalOutcome = "removed" | "absent" | "failed" | "forbidden" | "targetIsAdmin" | "participantInvalid";

export interface RemoveOneParams {
  chatId: number;
  userId: number;
  probeMembership: boolean;
  /** 本批开始时取得的停机取消信号（antiRaidDispatchSignal）。 */
  signal: AbortSignal;
}

/**
 * 处置一个 id，失败按线性退避重试；停机取消后不再进入下一次退避。
 * @returns removed=已封；absent=确认不在群，不必封；forbidden=机器人在这个群
 *   缺封禁权限，重试没有意义；targetIsAdmin=目标本身是管理员，只这一个封不掉；
 *   participantInvalid=补扫里尝试用尽，且每次探测与封禁都被 Telegram 以
 *   PARTICIPANT_ID_INVALID 拒绝；failed=尝试用尽或停机取消时仍未落定。
 */
async function removeOne({ chatId, userId, probeMembership, signal }: RemoveOneParams): Promise<RemovalOutcome> {
  let participantInvalid: boolean = probeMembership && userId > 0;
  for (let attempt: number = 1; attempt <= BLOCKLIST_REMOVAL_MAX_ATTEMPTS; attempt++) {
    // 频道马甲（sender_chat）没有「成员」这个概念，getChatMember 探不到，
    // 一律直接封掉它在本群的发言权（同 commands/block.ts 的处理）。
    if (userId < 0) {
      const outcome: BanChatMemberOutcome = await banChatSenderChatWithOutcome(chatId, userId, telegramApi);
      if (outcome === "banned") return "removed";
      // 同真人分支：权限不够时不重试。没有 targetIsAdmin 那一档可分辨，
      // 见 banChatSenderChatWithOutcome。
      if (outcome === "forbidden") return "forbidden";
    } else {
      if (probeMembership) {
        const probe: ChatMembershipProbeOutcome =
          await probeChatMembershipWithOutcome(chatId, userId, telegramApi);
        // 只有「确认不在群」才跳过；探测失败（429、网络抖动、PARTICIPANT_ID_INVALID）
        // 时照样封，封禁对不在群的 id 幂等。
        if (probe === "absent") return "absent";
        if (probe !== "participantInvalid") participantInvalid = false;
      }
      const outcome: BanChatMemberOutcome = await banChatMemberWithOutcome(chatId, userId, telegramApi);
      if (outcome === "banned") return "removed";
      if (outcome !== "participantInvalid") participantInvalid = false;
      // 权限不够不再消耗剩余尝试。判成群级「缺封禁权限」之前先探测目标是否管理员：
      // 是则归 targetIsAdmin（见 RemovalOutcome）；查不出身份时维持 forbidden。
      if (outcome === "forbidden") {
        return await probeChatAdmin({ chatId, userId, api: telegramApi }) === true
          ? "targetIsAdmin"
          : "forbidden";
      }
    }
    if (attempt < BLOCKLIST_REMOVAL_MAX_ATTEMPTS) {
      // 停机取消后不开始、也不继续等这次退避，本 id 按未落定结算，由 durable outbox
      // 在下一次启动重放。
      if (!await sleepUnlessAborted(BLOCKLIST_REMOVAL_RETRY_DELAY_MS * attempt, signal)) return "failed";
    }
  }
  return participantInvalid ? "participantInvalid" : "failed";
}

/** 一批处置的结局；permissionDenied 决定主线程是按时间重试还是等权限变更。 */
interface RemoveBatchResult {
  /** 每个 id 都已落定（封成功或确认不在群）；有一个没落定就是 false。 */
  complete: boolean;
  /** 没落定的原因里包含权限不够。 */
  permissionDenied: boolean;
  /**
   * 有目标因自身管理员身份没被封掉。与 complete 正交：这个批次不必重投，但
   * 这个群还留着人，主线程据此保留补扫欠账（见 BlockedMembersRemovedEvent）。
   */
  targetIsAdmin: boolean;
  /** 结局为 participantInvalid 的用户 ID，按处置顺序。 */
  readonly participantInvalidUserIds: number[];
  /** 结局为 removed、absent 或 targetIsAdmin 的用户 ID，按处置顺序；不含频道 ID。 */
  readonly settledUserIds: number[];
}

interface ApplyRemovalOutcomeParams {
  readonly chatId: number;
  readonly userId: number;
  readonly outcome: RemovalOutcome;
  readonly result: RemoveBatchResult;
}

/**
 * 把一个 id 的处置结局并进批次结果。
 * @returns false 表示机器人在这个群缺封禁权限，整批就此停下。
 */
function applyRemovalOutcome({ chatId, userId, outcome, result }: ApplyRemovalOutcomeParams): boolean {
  if (outcome === "removed") {
    if (userId > 0) result.settledUserIds.push(userId);
  } else if (outcome === "absent") {
    result.settledUserIds.push(userId);
  } else if (outcome === "forbidden") {
    result.complete = false;
    result.permissionDenied = true;
    logger.error(
      `Blocklist removal in chat ${chatId} is blocked by missing ban rights; stopping this batch.`
    );
    // 机器人在这个群封不了人，剩下的 id 不再处置，整批就此停下。
    return false;
  } else if (outcome === "targetIsAdmin") {
    // 就地结算：这个 id 因自身管理员身份封不掉，与机器人的权限无关；不计入未落定，
    // 也不触发群级权限受阻。批次回执带 targetIsAdmin 标记，主线程据此保留这个群的
    // 补扫欠账（sweptAt 不落），管理员降级后由下一次补扫（或他重新入群时的秒踢）接上。
    result.targetIsAdmin = true;
    result.settledUserIds.push(userId);
    logger.error(
      `Blocklisted user ${userId} is an administrator of chat ${chatId} and cannot be banned; ` +
      "settling this target and continuing with the rest of the batch."
    );
  } else {
    result.complete = false;
    if (outcome === "participantInvalid") result.participantInvalidUserIds.push(userId);
  }
  return true;
}

interface FinishRemovalBatchParams {
  readonly chatId: number;
  /** 批次开始时的处置世代；群在这期间被停管时不再删公告。 */
  readonly epoch: number;
  readonly announcementMessageId: number | undefined;
  readonly removed: number;
}

/** 批次收尾：删掉入群公告，记下移除人数。 */
async function finishRemovalBatch({
  chatId,
  epoch,
  announcementMessageId,
  removed,
}: FinishRemovalBatchParams): Promise<void> {
  // 入群公告：黑名单入群不投 join，处置走完后由这里删除这条服务消息。
  //
  // 确证没有删消息权限时不发请求（三态里只拦确证的 false，见 ./botPermissions.ts），
  // 口径与 adDetect/disposal.ts 和验证处置路径相同。
  if (
    announcementMessageId !== undefined &&
    currentBlocklistRemovalEpoch(chatId) === epoch &&
    botCanDeleteIn(chatId) !== false
  ) {
    await deleteMessage(chatId, announcementMessageId, telegramApi);
  }
  if (removed > 0) logger.log(`Removed ${removed} blocklisted member(s) from chat ${chatId}.`);
}

/**
 * 逐个处置一批黑名单 id。
 * @returns 落定情况；主线程据此决定保留镜像、是否把这个群标成已清扫，以及
 *   要不要停掉这个群按时间的重试。
 */
async function removeBlockedMembers({
  chatId,
  userIds,
  probeMembership,
  joinedAt,
  announcementMessageId,
}: RemoveBlockedMembersParams): Promise<RemoveBatchResult> {
  // 入群计数同步完成、与网络无关，先记：黑名单入群不投 join，由这里补记入群计数。
  //
  // 记的是**本线程观测到的时刻** now，不是 joinedAt 本身：recordJoin 的第二个参数
  // 按「现在」处理，见 libs/timestampDeque.ts 的 trim 契约。
  if (joinedAt !== undefined) {
    const now: number = Date.now();
    // 已经滑出窗口（JOIN_WINDOW_MS）的补记直接丢弃，跨进程重放带来的 joinedAt 不计入。
    if (now - joinedAt < JOIN_WINDOW_MS) recordJoin(chatId, now);
  }
  const epoch: number = currentBlocklistRemovalEpoch(chatId);
  const signal: AbortSignal = antiRaidDispatchSignal();
  let removed: number = 0;
  const result: RemoveBatchResult = {
    complete: true,
    permissionDenied: false,
    targetIsAdmin: false,
    participantInvalidUserIds: [],
    settledUserIds: [],
  };
  // 镜像已确证缺封禁权限（三态里只认确证的 false，见 ./botPermissions.ts）：整批不发请求，
  // 直接按权限受阻回执，由主线程闩住这个群并记日志；入群计数与入群公告清理照常。
  if (botCanRestrictIn(chatId) === false) {
    result.complete = false;
    result.permissionDenied = true;
    await finishRemovalBatch({ chatId, epoch, announcementMessageId, removed });
    return result;
  }
  for (let index: number = 0; index < userIds.length; index++) {
    // 群已被停管：整批放弃，且不算完成——重新接管后会有新的边沿再扫一次。
    if (currentBlocklistRemovalEpoch(chatId) !== epoch) {
      result.complete = false;
      return result;
    }
    // Worker 正在停机：不再开始新的处置，整批按未完成回执，durable outbox 在
    // 下一次启动重放（见 cache/workers/antiRaid/tasks.ts 的 antiRaidDispatchAbort）。
    if (signal.aborted) {
      result.complete = false;
      return result;
    }
    // 每 BLOCKLIST_SWEEP_BATCH_SIZE 个 id 暂停 BLOCKLIST_SWEEP_BATCH_PAUSE_MS，
    // 让出 kick 类别的 429 FIFO 与 Worker mailbox。
    if (
      index > 0 &&
      index % BLOCKLIST_SWEEP_BATCH_SIZE === 0 &&
      !await sleepUnlessAborted(BLOCKLIST_SWEEP_BATCH_PAUSE_MS, signal)
    ) {
      result.complete = false;
      return result;
    }
    const userId: number = userIds[index]!;
    const outcome: RemovalOutcome = await removeOne({ chatId, userId, probeMembership, signal });
    if (outcome === "removed") removed++;
    if (!applyRemovalOutcome({ chatId, userId, outcome, result })) break;
  }
  await finishRemovalBatch({ chatId, epoch, announcementMessageId, removed });
  return result;
}

export interface HandleRemoveBlockedMembersParams {
  msg: RemoveBlockedMembersMessage;
  /** 回执通道（Worker -> 主线程）；由 antiRaidWorker.ts 注入 self.postMessage。 */
  publish: (event: BlockedMembersRemovedEvent) => void;
}

/**
 * 处置入口：立即启动并返回登记过的后台任务，mailbox 调度器不 await；结束后
 * 回执。回执带 complete——主线程只在 complete 时销镜像并把群标成已清扫，
 * 否则留着等重投或下一次边沿。
 */
export function handleRemoveBlockedMembers({ msg, publish }: HandleRemoveBlockedMembersParams): Promise<void> {
  const task: Promise<void> = removeBlockedMembers(msg)
    .then((result: RemoveBatchResult): void => {
      // 回执先发；其后的去重记录回收是尽力而为的清理，不影响已确定的结果。
      publish({
        type: "blockedMembersRemoved",
        chatId: msg.chatId,
        removalId: msg.removalId,
        complete: result.complete,
        permissionDenied: result.permissionDenied,
        targetIsAdmin: result.targetIsAdmin,
        participantInvalidUserIds: result.participantInvalidUserIds,
        settledUserIds: result.settledUserIds,
      });
      // 非探测批次里的目标已确认封禁后，尝试释放同 key 的广告判定去重记录；
      // release 内部只认 direct-ad 标记，不会碰手工 /block 或秒踢的待检 bundle。
      // 自带 try，失败不会进入下面的 .catch 补发回执。
      if (result.complete && !result.targetIsAdmin && !msg.probeMembership) {
        try {
          for (const userId of msg.userIds) {
            releaseAdDetectDedupKey(msg.chatId, userId);
          }
        } catch (error: unknown) {
          logger.error(
            `Failed to release ad-detect disposal markers for chat ${msg.chatId}:`,
            error
          );
        }
      }
    })
    .catch((error: unknown): void => {
      logger.error(`Failed to remove blocklisted members from chat ${msg.chatId}:`, error);
      // 意外异常不是权限问题：显式给 false，让这批照常走按时间的重试。
      publish({
        type: "blockedMembersRemoved",
        chatId: msg.chatId,
        removalId: msg.removalId,
        complete: false,
        permissionDenied: false,
        targetIsAdmin: false,
        participantInvalidUserIds: [],
        settledUserIds: [],
      });
    });
  return trackAntiRaidTask({ task, blocklistChatId: msg.chatId });
}
