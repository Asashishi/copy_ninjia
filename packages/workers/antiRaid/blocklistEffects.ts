/**
 * /block 黑名单的处置副作用（入群守卫线程侧）。判定不在这里——名单是主线程
 * 状态，`isUserBlocked` 在主线程同步查完才投递本消息（见 infra/blocklist/
 * 与 antiRaid/blocklistGuard.ts）。本模块负责「把这些 id 清出这个群」这一步：
 * 探测、封禁、失败重试，以及秒踢路径顺带的入群计数与公告清理。
 *
 * 放在 Worker 里的理由和验证超时踢人一样：请求走 joinVerificationApi，与普通
 * 消息发送分开排队（见 infra/telegram/client.ts）；而且不占主线程处理 update
 * 的时间——新晋管理员后的补扫是 O(名单长度) 次 getChatMember，压在主线程上
 * 会把那个群的更新车道堵住。
 *
 * 与本线程其它副作用共用同一条节奏：dispatch 里同步的部分立即返回，网络请求
 * 事后串行执行，绝不阻塞 mailbox——否则一波刷屏入群的后续投递会被网络往返卡住。
 *
 * 三条与「一次失败就等于放人进群」直接相关的约束（见 docs/04-invariants.md）：
 * - 失败必须重试，且最终结果要回执给主线程。黑名单入群不开验证窗口，没有
 *   超时踢人兜底，处置是这个人被清出去的唯一机会。
 * - 探测失败不算「不在群」。只有确认不在群才跳过，其余一律照封。
 * - 群停管后立刻放弃在途批次，避免在已经不归自己管的群里继续封人。
 *
 * 还有一条与「一个 id 卡住整个群」相关：`permissionDenied` 只能由**机器人自己
 * 缺权限**触发。Telegram 用同一句 400 表达「目标是管理员」，混进去就会把整个群
 * 的清扫永久闩死，见 RemovalOutcome 的 targetIsAdmin。
 */

import { banChatMemberWithOutcome, banChatSenderChatWithOutcome, deleteMessage, joinVerificationApi, probeChatAdmin, probeChatMembership } from "../../infra/telegram";
import type { BanChatMemberOutcome } from "../../infra/telegram";
import { logger } from "../../infra/logger";
import { botCanDeleteIn } from "./botPermissions";
import { recordJoin } from "./lockdownRuntime";
import { currentBlocklistRemovalEpoch } from "../../cache/workers/antiRaid/blocklist";
import {
  BLOCKLIST_REMOVAL_MAX_ATTEMPTS,
  BLOCKLIST_REMOVAL_RETRY_DELAY_MS,
  BLOCKLIST_SWEEP_BATCH_PAUSE_MS,
  BLOCKLIST_SWEEP_BATCH_SIZE,
} from "../../consts/antiRaid/blocklist";
import { JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import type { BlockedMembersRemovedEvent, RemoveBlockedMembersMessage } from "../../types/antiRaid";
import type { RemoveBlockedMembersParams } from "../../types/blocklist";
import { trackAntiRaidTask } from "./taskTracker";

/**
 * 单个 id 的处置结局。
 *
 * `forbidden` 从 `failed` 里单独分出来：那是「机器人在这个群封不了人」，主线程
 * 据此停掉这个群按时间的重试，只等一次确证的权限变更（见 docs/04-invariants.md）。
 * `targetIsAdmin` 又从 `forbidden` 里分出来：Telegram 对「目标本身是管理员」返回
 * 的也是 400 `not enough rights`，混在一起就意味着一个封不掉的管理员会把**整个群**
 * 的黑名单清扫永久闩死——此后补扫早退、重扫请求被拒、每次重启跳过重放，而唯一
 * 的解锁边沿是「机器人的封禁权限变了」，那件事根本不会发生。这一档只结算这个
 * 目标，不动群级的 permissionBlocked。
 */
type RemovalOutcome = "removed" | "absent" | "failed" | "forbidden" | "targetIsAdmin";

export interface RemoveOneParams {
  chatId: number;
  userId: number;
  probeMembership: boolean;
}

/**
 * 处置一个 id，失败按线性退避重试。
 * @returns removed=已封；absent=确认不在群，不必封；forbidden=机器人在这个群
 *   缺封禁权限，重试没有意义；targetIsAdmin=目标本身是管理员，只这一个封不掉；
 *   failed=尝试用尽仍未落定。
 */
async function removeOne({ chatId, userId, probeMembership }: RemoveOneParams): Promise<RemovalOutcome> {
  for (let attempt: number = 1; attempt <= BLOCKLIST_REMOVAL_MAX_ATTEMPTS; attempt++) {
    // 频道马甲（sender_chat）没有「成员」这个概念，getChatMember 探不到，
    // 一律直接封掉它在本群的发言权（同 commands/block.ts 的处理）。
    if (userId < 0) {
      const outcome: BanChatMemberOutcome = await banChatSenderChatWithOutcome(chatId, userId, joinVerificationApi);
      if (outcome === "banned") return "removed";
      // 同真人分支：权限不够时重试没有意义，这批等的是权限变更。没有
      // targetIsAdmin 那一档可分辨，理由见 banChatSenderChatWithOutcome。
      if (outcome === "forbidden") return "forbidden";
    } else {
      if (probeMembership) {
        const present: boolean | undefined = await probeChatMembership(chatId, userId, joinVerificationApi);
        // 只有「确认不在群」才跳过。探测失败（429、网络抖动）时照样封：对一个
        // 本来就不在群里的黑名单 id 多封一次是幂等的，效果只是提前封住；反过来
        // 把失败当成「不在群」，坐在群里的人就被静默放过了。
        if (present === false) return "absent";
      }
      const outcome: BanChatMemberOutcome = await banChatMemberWithOutcome(chatId, userId, joinVerificationApi);
      if (outcome === "banned") return "removed";
      // 权限不够不再消耗剩余尝试：同一秒里重试三次只是把同一条报错刷三遍，
      // 这个批次要等的是权限变更，不是下一次退避。但在把这个群整体判成「缺
      // 封禁权限」之前必须先分辨一次：同一句 400 也可能只是说「这个目标是
      // 管理员」，那是一个 id 的事，不该闩住整个群（见 RemovalOutcome）。
      // 查不出身份时维持原判——没有确证就不把群级闩锁降级成逐个重试。
      if (outcome === "forbidden") {
        return await probeChatAdmin(chatId, userId, joinVerificationApi) === true
          ? "targetIsAdmin"
          : "forbidden";
      }
    }
    if (attempt < BLOCKLIST_REMOVAL_MAX_ATTEMPTS) {
      await Bun.sleep(BLOCKLIST_REMOVAL_RETRY_DELAY_MS * attempt);
    }
  }
  return "failed";
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
  // 入群计数是同步的、与网络无关，先记：黑名单入群不再投 join，若不在这里
  // 补记，一波以黑名单账号为主的刷群就凑不够反刷群窗口的阈值。
  //
  // 记的是**本线程观测到的时刻**，不是 joinedAt 本身。recordJoin 把第二个参数
  // 当成「现在」交给 trimSlidingWindow，而后者按契约会把所有落在「未来」的队尾
  // 判成系统时钟回拨并丢掉（见 libs/slidingWindowRateLimit.ts）。joinedAt 是主
  // 线程在 durable outbox flush **之前**取的，必然早于本线程随后用自己的
  // Date.now() 记下的那些入群——直接传进去，一次补记就能把同一批里刚记下的真实
  // 入群整段抹掉，窗口计数永远爬不到 ANTI_RAID_PER_MINUTE_LIMIT，紧急私密模式
  // 再也不会触发。差价只有一次 flush 的时间，方向也偏向「更晚出窗口」。
  if (joinedAt !== undefined) {
    const now: number = Date.now();
    // 已经滑出窗口的补记直接丢弃：跨进程重放（启动恢复、Worker 重生）带来的
    // joinedAt 属于上一个进程的入群潮，把它对齐到现在就是凭空多算一次入群。
    if (now - joinedAt < JOIN_WINDOW_MS) recordJoin(chatId, now);
  }
  const epoch: number = currentBlocklistRemovalEpoch(chatId);
  let removed: number = 0;
  let complete: boolean = true;
  let permissionDenied: boolean = false;
  let targetIsAdmin: boolean = false;
  for (let index: number = 0; index < userIds.length; index++) {
    // 群已被停管：整批放弃，且不算完成——重新接管后会有新的边沿再扫一次。
    if (currentBlocklistRemovalEpoch(chatId) !== epoch) return { complete: false, permissionDenied, targetIsAdmin };
    // 补扫可能有几千个 id，且与验证超时踢人共用同一条限流队列；每批之间让一步，
    // 给排在后面的踢人请求留出插空的机会。
    if (index > 0 && index % BLOCKLIST_SWEEP_BATCH_SIZE === 0) {
      await Bun.sleep(BLOCKLIST_SWEEP_BATCH_PAUSE_MS);
    }
    const userId: number = userIds[index]!;
    const outcome: RemovalOutcome = await removeOne({ chatId, userId, probeMembership });
    if (outcome === "removed") removed++;
    else if (outcome === "forbidden") {
      complete = false;
      permissionDenied = true;
      // 机器人在这个群根本封不了人，剩下的 id 只会一个个撞上同一句 400。补扫
      // 可能有几千个 id，每个两次注定失败的请求外加分批暂停，全压在与验证超时
      // 踢人共用的队列上——发现这件事的这一次补扫本身就是要避免的那场风暴。
      break;
    } else if (outcome === "targetIsAdmin") {
      // 就地结算：这个 id 在这个群封不掉，但那是他自己的管理员身份决定的，
      // 与机器人的权限无关。算进未落定只会让整批永远重试；算成群级权限受阻
      // 更糟——那会连累同批其余 id 一起停摆。改用一条独立回执让主线程保住这个
      // 群的补扫欠账（sweptAt 不落），管理员降级后由下一次补扫（或他自己重新
      // 入群时的秒踢）接上——那正是这行日志承诺的事。
      targetIsAdmin = true;
      logger.error(
        `Blocklisted user ${userId} is an administrator of chat ${chatId} and cannot be banned; ` +
        "settling this target and continuing with the rest of the batch."
      );
    } else if (outcome === "failed") complete = false;
  }
  // 入群公告：不投 join 就没人再管这条服务消息了，处置走完顺手删掉。
  //
  // 确证没有删消息权限时一条请求都不发（三态里只拦确证的 false，理由见
  // ./botPermissions.ts）：机器人完全可能是「有 can_restrict_members、没有
  // can_delete_messages」的管理员，那种群里每个黑名单入群都换来一次注定 400 的
  // 删除，而这些请求排在与验证超时踢人共用的 joinVerificationApi FIFO 队列上——
  // 一波协同入群时，它们会把真正的踢人顶到验证窗口之后，公告本身照样删不掉。
  // 与 adDetect/disposal.ts 和验证处置路径共用同一道闸。
  if (
    announcementMessageId !== undefined &&
    currentBlocklistRemovalEpoch(chatId) === epoch &&
    botCanDeleteIn(chatId) !== false
  ) {
    await deleteMessage(chatId, announcementMessageId, joinVerificationApi);
  }
  if (removed > 0) logger.log(`Removed ${removed} blocklisted member(s) from chat ${chatId}.`);
  if (permissionDenied) {
    logger.error(
      `Blocklist removal in chat ${chatId} is blocked by missing ban rights; ` +
      "it will stay pending until the bot's permissions there change."
    );
  }
  return { complete, permissionDenied, targetIsAdmin };
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
      publish({
        type: "blockedMembersRemoved",
        chatId: msg.chatId,
        removalId: msg.removalId,
        complete: result.complete,
        permissionDenied: result.permissionDenied,
        targetIsAdmin: result.targetIsAdmin,
      });
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
      });
    });
  return trackAntiRaidTask({ task, blocklistChatId: msg.chatId });
}
