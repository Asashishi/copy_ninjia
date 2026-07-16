import { logger } from "../infra/logger";
import { InlineKeyboard } from "grammy";
import type { ChatPermissions } from "@grammyjs/types";
import {
  sendMessage,
  deleteMessage,
  deleteMessageAfter,
  kickChatMember,
  answerCallbackQuery,
  joinVerificationApi,
} from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { formatMinSec } from "../libs/time";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../consts/telegram";
import { PRIVILEGED_USERS_ID } from "../infra/config";
import {
  ADMIN_CACHE_TTL_MS,
  COMMENT_JOIN_CORRELATE_MS,
  JOIN_THRESHOLD,
  JOIN_WINDOW_MS,
  LINKED_CHANNEL_TTL_MS,
  LOCKDOWN_KICK_DEDUPE_MS,
  LOCKDOWN_MS,
  VERIFICATION_BUTTON_TEXT,
  VERIFICATION_TIMEOUT_MS,
  VERIFY_CALLBACK_PREFIX,
  WELCOME_AUTO_DELETE_MS,
} from "../consts/antiRaid";
import {
  adminFetches,
  chatAdmins,
  joinWindows,
  linkedChannelFetches,
  linkedChannels,
  lockdownApiChains,
  lockdownEntries,
  recentChannelComments,
  verificationEntries,
} from "../cache/antiRaidWorker";
import type {
  AdoptableLockdown,
  AntiRaidMember,
  AntiRaidWorkerMessage,
  LockdownEvent,
  NewMemberMessage,
  TrackedChatMessage,
  UnlockEvent,
  VerifyCallbackMessage,
} from "../types";
import {
  joinCreatesNewRecord,
  transitionVerification,
  type ExpelSnapshot,
  type JoinEvent,
  type VerificationEffect,
  type VerificationEvent,
  type VerificationState,
} from "../states/verification";
import {
  transitionLockdown,
  type LockdownEffect,
  type LockdownMachineEvent,
} from "../states/lockdown";

/**
 * 入群守卫线程（Bun Worker）：入群验证 + 反刷群私密模式的合并流水线。
 * 主线程（src/auto/message.ts / index.ts → antiRaid.ts 代理）只做事件投递。
 *
 * 本文件是两台状态机（src/states/verification.ts / lockdown.ts）的
 * 解释器：把每条投递翻译成状态机事件、同步落下一状态、管理计时器、把
 * 返回的副作用列表逐个执行。所有「哪些标志组合走哪条分支」的判定都在
 * 状态机的纯转移函数里，这里只剩 I/O 与线程胶水。关键约定：
 * - dispatch 里状态更替是同步的，副作用（网络请求）一律事后执行——消息
 *   按 FIFO 逐条处理，同一波刷屏入群的后续投递不会被网络往返卡住，
 *   越过阈值那次入群触发的私密模式占位对同批后续入群立即生效。
 * - 异步回调（提醒落地回填、管理员核查）以「状态对象同一性」识别过期：
 *   状态一旦被替换/删除，捕获的旧引用对不上，回调自动放弃。
 *
 * 发往 Telegram 的调用不回主线程绕路——本线程 import telegram.ts 时会得到
 * 自己独立的 grammY Api 客户端（用带限流 + 429 自动重试的 joinVerificationApi，
 * 突发的删/踢/发在这里排队，不占用主线程共享客户端）。error 日志经 logger.ts
 * 的转发模式回传主线程统一落盘。
 *
 * lockdown/unlock 事件回报主线程用于持久化 + Worker 崩溃后的 adopt 重放，
 * 机制见 antiRaid.ts（验证状态则随线程丢失：残留的验证按钮点了会得到
 * 「已失效」应答，重新进群即可）。
 */

declare var self: Worker;

function verificationKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function memberLabel(member: AntiRaidMember): string {
  return formatUserLabel({ id: member.id, username: member.username, first_name: member.first_name });
}

// —— 管理员表（管理员拉人免验证的判定依据） ——

/** 未过期的某群管理员 ID 集合；没拉取过或已过期则返回 undefined，让调用方走异步兜底。 */
function freshAdminIds(chatId: number): Set<number> | undefined {
  const cached = chatAdmins.get(chatId);
  if (!cached || Date.now() - cached.fetchedAt > ADMIN_CACHE_TTL_MS) return undefined;
  return cached.adminIds;
}

/**
 * 一次全量拉取（fetchAdminIds）进行中期间到达的管理员增量变化：chatId ->
 * (userId -> isAdmin)，落地时（无论此刻有没有已有缓存条目）都会记一份在
 * 这里，全量拉取的结果落地后立即在新快照基础上重放、再清空，见 fetchAdminIds
 * 与 applyAdminChange。避免"迟到的全量快照 resolve 时直接整份覆盖缓存"
 * 把拉取在途期间已经发生的、更新的增量变化悄悄冲掉——尤其是缓存此刻还
 * 完全没有条目（第一次拉取还没落地）的情形：不缓冲的话 applyAdminChange
 * 会因为 !cached 直接静默丢弃这次变化，且不像有缓存条目时那样能事后从
 * 「原地增删」里看出丢了什么，只能等到 ADMIN_CACHE_TTL_MS（1 小时）后
 * 下一次全量刷新才纠正。
 */
const pendingAdminChangesDuringFetch: Map<number, Map<number, boolean>> = new Map();

/** 全量拉取某群的管理员表并落缓存（带进行中去重，见 adminFetches）。 */
function fetchAdminIds(chatId: number): Promise<Set<number>> {
  let inFlight = adminFetches.get(chatId);
  if (!inFlight) {
    inFlight = joinVerificationApi
      .getChatAdministrators(chatId)
      .then((admins) => {
        const adminIds: Set<number> = new Set(admins.map((admin) => admin.user.id));
        // 拉取在途期间到达的增量变化比这份快照更新（chat_member 更新是
        // 近实时的权威信号），重放在其上，不能被这次 resolve 覆盖掉——见
        // pendingAdminChangesDuringFetch 注释。
        const pending = pendingAdminChangesDuringFetch.get(chatId);
        if (pending) {
          for (const [userId, isAdmin] of pending) {
            if (isAdmin) adminIds.add(userId);
            else adminIds.delete(userId);
          }
          pendingAdminChangesDuringFetch.delete(chatId);
        }
        chatAdmins.set(chatId, { adminIds, fetchedAt: Date.now() });
        return adminIds;
      })
      .finally(() => adminFetches.delete(chatId));
    adminFetches.set(chatId, inFlight);
  }
  return inFlight;
}

/**
 * 应用一条管理员任免事件（主线程从 chat_member 更新里提取）。原地增删已有的
 * 缓存条目——还没按需拉取过的群没有条目可改，之后的首次全量拉取天然是最新的。
 * 若此刻恰好有一次全量拉取在途，额外把这次变化记进 pendingAdminChangesDuringFetch，
 * 由 fetchAdminIds 的 resolve 回调重放，避免被迟到的快照覆盖/漏收（见其注释）。
 */
function applyAdminChange(chatId: number, userId: number, isAdmin: boolean): void {
  if (adminFetches.has(chatId)) {
    let pending = pendingAdminChangesDuringFetch.get(chatId);
    if (!pending) {
      pending = new Map();
      pendingAdminChangesDuringFetch.set(chatId, pending);
    }
    pending.set(userId, isAdmin);
  }
  const cached = chatAdmins.get(chatId);
  if (!cached) return;
  if (isAdmin) {
    cached.adminIds.add(userId);
  } else {
    cached.adminIds.delete(userId);
  }
}

// —— 频道评论区留言的暂存（评论先到、入群更新后到时的关联缓冲） ——

/**
 * 暂存一条「发言者当前没有验证状态记录」的评论区留言/线程回复，等这条留言
 * 触发的自动拉群（chat_member 更新可能后到）来消费。同一人连发多条只留
 * 最新的；直接回复频道帖的标记一旦出现就保持（豁免的确证不被后续楼中楼
 * 回复降级）。
 */
function rememberRecentComment(chatId: number, userId: number, messageId: number, repliesToChannelPost: boolean): void {
  const key: string = verificationKey(chatId, userId);
  const existing = recentChannelComments.get(key);
  if (existing) clearTimeout(existing.cleanup);
  recentChannelComments.set(key, {
    messageId,
    repliesToChannelPost: repliesToChannelPost || existing?.repliesToChannelPost === true,
    cleanup: setTimeout(() => recentChannelComments.delete(key), COMMENT_JOIN_CORRELATE_MS),
  });
}

/** 消费（取出并删除）某人最近暂存的评论区留言，没有则返回 undefined。 */
function takeRecentComment(chatId: number, userId: number): { messageId: number; repliesToChannelPost: boolean } | undefined {
  const key: string = verificationKey(chatId, userId);
  const entry = recentChannelComments.get(key);
  if (!entry) return undefined;
  clearTimeout(entry.cleanup);
  recentChannelComments.delete(key);
  return { messageId: entry.messageId, repliesToChannelPost: entry.repliesToChannelPost };
}

/**
 * 本群有没有关联频道（getChat 的 linked_chat_id），带 TTL 缓存 + 进行中
 * 去重。没有关联频道的群不存在评论区，楼中楼判定应整体跳过——
 * message_thread_id 在普通回复链上也可能出现，不收窄的话普通群里的回复
 * 会误走「追发提醒」路径。缓存未命中时先按「有」处理（误判只是提醒的
 * 锚点选择不同，代价很小；漏判则会让评论区进来的真人错过频道侧的按钮），
 * 同时异步拉取回填，之后按真实结果判定。
 */
function chatHasLinkedChannel(chatId: number): boolean {
  const cached = linkedChannels.get(chatId);
  if (cached && Date.now() - cached.fetchedAt <= LINKED_CHANNEL_TTL_MS) return cached.hasLinked;
  if (!linkedChannelFetches.has(chatId)) {
    const inFlight: Promise<void> = joinVerificationApi
      .getChat(chatId)
      .then((chat) => {
        linkedChannels.set(chatId, { hasLinked: "linked_chat_id" in chat && chat.linked_chat_id !== undefined, fetchedAt: Date.now() });
      })
      .catch((error: unknown) => {
        logger.error(`Error fetching linked channel info for chat ${chatId}:`, error);
      })
      .finally(() => linkedChannelFetches.delete(chatId));
    linkedChannelFetches.set(chatId, inFlight);
  }
  return cached ? cached.hasLinked : true;
}

// —— 验证状态机解释器 ——

/** pending 起验证超时计时，exempt/kicked 起去重窗口计时（到期事件回投状态机）。 */
function startVerificationTimer(chatId: number, userId: number, state: VerificationState): ReturnType<typeof setTimeout> {
  if (state.kind === "pending") {
    return setTimeout(() => dispatchVerification(chatId, userId, { type: "verifyTimeout" }), VERIFICATION_TIMEOUT_MS);
  }
  return setTimeout(() => dispatchVerification(chatId, userId, { type: "dedupeExpired" }), LOCKDOWN_KICK_DEDUPE_MS);
}

/**
 * 把一个事件喂给某成员的验证状态机并落地结果。状态更替（含计时器换挡）
 * 在返回前同步完成；副作用异步执行、不阻塞后续投递。
 */
function dispatchVerification(chatId: number, userId: number, event: VerificationEvent): void {
  const key: string = verificationKey(chatId, userId);
  const entry = verificationEntries.get(key);
  const { next, effects } = transitionVerification(entry?.state, event);
  if (next !== entry?.state) {
    if (entry) clearTimeout(entry.timer);
    if (next === undefined) {
      verificationEntries.delete(key);
    } else {
      verificationEntries.set(key, { state: next, timer: startVerificationTimer(chatId, userId, next) });
    }
  }
  if (effects.length > 0) {
    void runVerificationEffects(chatId, userId, effects).catch((error: unknown) => {
      logger.error("Error running join verification effects:", error);
    });
  }
}

/** 按序执行一次转移返回的副作用（同一列表内先删后踢再通知的顺序有意义）。 */
async function runVerificationEffects(chatId: number, userId: number, effects: VerificationEffect[]): Promise<void> {
  for (const effect of effects) {
    switch (effect.kind) {
      case "deleteMessage":
        await deleteMessage(chatId, effect.messageId, joinVerificationApi);
        break;
      case "kickMember":
        await kickChatMember(chatId, userId, joinVerificationApi);
        break;
      case "deleteReminders":
        if (effect.reminderMessageId !== undefined) await deleteMessage(chatId, effect.reminderMessageId, joinVerificationApi);
        if (effect.replyReminderMessageId !== undefined) await deleteMessage(chatId, effect.replyReminderMessageId, joinVerificationApi);
        break;
      case "expel":
        await expelMember(chatId, userId, effect.snapshot);
        break;
      case "recheckInviter":
        await recheckInviterThenSettle(chatId, userId, effect.inviterId, effect.snapshot);
        break;
      case "sendReminder":
        sendVerificationReminder(chatId, userId, effect.label, effect.isBot);
        break;
      case "sendReplyReminder":
        sendReplyReminder(chatId, userId, effect.label, effect.targetMessageId, effect.inCommentThread);
        break;
      case "sendWelcome": {
        const welcomeText: string =
          effect.variant === "channelComment"
            ? `哼，${effect.targetLabel} 老实巴交的在帖子底下冒个了泡，本天才大发慈悲免了你的验证，欢迎杂鱼入群~♡`
            : effect.variant === "vouchedBot"
              ? `哼，既然 ${effect.fromLabel} 大人愿意为机器人 ${effect.targetLabel} 作保，本天才就勉为其难放这个铁疙瘩进来啦~♡`
              : `哼，算你机灵，${effect.fromLabel} 通过验证啦，欢迎杂鱼入群~♡`;
        const welcomeMessageId: number | undefined = await sendMessage(chatId, welcomeText, effect.anchorMessageId, joinVerificationApi);
        if (welcomeMessageId !== undefined) {
          deleteMessageAfter(chatId, welcomeMessageId, WELCOME_AUTO_DELETE_MS, joinVerificationApi);
        }
        break;
      }
      case "answerCallback": {
        const replyText: string | undefined =
          effect.reply === "ok"
            ? "验证通过啦～"
            : effect.reply === "invalid"
              ? "验证已经失效啦，再试试重新进群吧"
              : effect.reply === "notYourBotButton"
                ? "帮机器人作保是白名单大人的特权，杂鱼别乱点～"
                : "这不是你的验证按钮哦，杂鱼别乱点～";
        await answerCallbackQuery(effect.callbackQueryId, replyText, effect.reply !== "ok", joinVerificationApi);
        break;
      }
      case "startAdminCheck":
        startAdminCheck(chatId, userId, effect.actorId);
        break;
      case "logStaleKickedExemption":
        logger.warn(
          `Member ${effect.label} (chat ${chatId}, user ${userId}) was already kicked (anti-raid lockdown or the join-dedupe window) ` +
          `when exemption proof (admin/whitelist identity) arrived; the kick cannot be undone automatically — ` +
          `an admin may need to manually re-invite them if this was a false positive.`
        );
        break;
      case "restartVerifyTimer": {
        const entry = verificationEntries.get(verificationKey(chatId, userId));
        if (entry && entry.state.kind === "pending") {
          clearTimeout(entry.timer);
          entry.timer = startVerificationTimer(chatId, userId, entry.state);
        }
        break;
      }
    }
  }
}

/**
 * 两种验证提醒（原始独立 / 回复式补发）共用的发送管线：发送前若捕获到的
 * 状态已经不是 pending（未验证前被踢、离群、豁免、已通过……），说明这条
 * 提醒的前提已经不成立，直接放弃发送——不然会给已经不需要验证的成员或
 * 全群甩出一条过期的「限时验证否则踢出」威胁。
 * 发送本身不等待完成：它经过限流的 joinVerificationApi，真实刷群场景下若
 * 在这里 await，同一波入群投递会逐个排队等发消息，可能导致 60 秒的反防
 * 刷群计数窗口在真正数满阈值之前就先重置——刷群反而检测不到。发送结果以
 * reminderLanded 事件异步回填；落地时状态已被替换/删除（限流排队太久，
 * 验证已经结束）则直接自删，迟到的提醒不删的话会永远留在聊天里。
 * 调用方必须在状态转移的同一 tick 内同步调用（不能排在被 await 的效果
 * 之后）：这里捕获的 captured 快照才等于转移刚落下的那个状态，落地时的
 * 同一性比对才有意义，也不会被交错到达的其他投递抢先替换/删除状态。
 */
function sendReminderMessage(
  chatId: number,
  userId: number,
  reminderKind: "original" | "reply",
  text: string,
  replyToMessageId: number | undefined
): void {
  const key: string = verificationKey(chatId, userId);
  const captured: VerificationState | undefined = verificationEntries.get(key)?.state;
  if (captured === undefined || captured.kind !== "pending") return;
  const verifyKeyboard: InlineKeyboard = new InlineKeyboard().text(VERIFICATION_BUTTON_TEXT, `${VERIFY_CALLBACK_PREFIX}${userId}`);
  void sendMessage(chatId, text, replyToMessageId, joinVerificationApi, verifyKeyboard)
    .then((reminderMessageId: number | undefined) => {
      if (reminderMessageId === undefined) return;
      if (verificationEntries.get(key)?.state === captured) {
        dispatchVerification(chatId, userId, { type: "reminderLanded", reminderKind, messageId: reminderMessageId });
      } else {
        void deleteMessage(chatId, reminderMessageId, joinVerificationApi);
      }
    })
    .catch((error: unknown) => {
      logger.error(`Error sending ${reminderKind} join verification reminder:`, error);
    });
}

/**
 * 发送原始独立提醒（带验证按钮）。机器人看不到这条提醒也点不了按钮
 * （Bot API 不向机器人投递其他机器人的消息），提醒是说给群里的白名单
 * 用户听的：得有人代它点按钮作保。
 */
function sendVerificationReminder(chatId: number, userId: number, label: string, isBot: boolean): void {
  const reminderText: string = isBot
    ? `哦？谁把 ${label} 这个机器人拎进来的？铁疙瘩自己可点不了按钮——` +
      `${formatMinSec(VERIFICATION_TIMEOUT_MS)}内得有白名单大人帮它点下面的按钮作保，` +
      `不然本天才就把这个来路不明的铁皮杂鱼扔出去哦♡`
    : `喂，${label}，新来的杂鱼给本天才听好了，` +
      `${formatMinSec(VERIFICATION_TIMEOUT_MS)}内点下面的按钮证明你不是机器人，` +
      `不然本天才就把你的发言全部抹掉再一脚把你踢出去哦♡`;
  sendReminderMessage(chatId, userId, "original", reminderText, undefined);
}

/**
 * 把带验证按钮的提醒以「回复 TA 那条消息」的形式补发一份（楼中楼场景按钮
 * 在频道侧可见可点，普通发言场景回复会给 TA 推通知）。
 */
function sendReplyReminder(chatId: number, userId: number, label: string, targetMessageId: number, inCommentThread: boolean): void {
  const reminderText: string = inCommentThread
    ? `喂，${label}，本天才瞧见你在评论区冒泡了。新来的杂鱼规矩要懂：` +
      `${formatMinSec(VERIFICATION_TIMEOUT_MS)}内点下面的按钮证明你不是机器人，` +
      `不然留言全删、人也一脚踢出去哦♡`
    : `喂，${label}，话都说上了，下面的验证按钮倒是点一下啊杂鱼。` +
      `再装看不见的话，本天才可要连人带消息一块清出去咯♡`;
  sendReminderMessage(chatId, userId, "reply", reminderText, targetMessageId);
}

/**
 * 发起「拉人者是不是管理员」的异步核查：全量拉取管理员表（顺手把缓存补热），
 * 确认是管理员则把 adminCheckResolved 回投状态机撤销验证窗口。fetchAdminIds
 * 自带进行中去重，两路投递重复挂载只是对同一结果多检查一遍，先撤销者生效，
 * 后到的发现状态对象已被替换即放弃。
 */
function startAdminCheck(chatId: number, userId: number, actorId: number): void {
  const key: string = verificationKey(chatId, userId);
  const captured: VerificationState | undefined = verificationEntries.get(key)?.state;
  if (captured === undefined || captured.kind !== "pending") return;
  void fetchAdminIds(chatId)
    .then((adminIds: Set<number>) => {
      if (!adminIds.has(actorId)) return;
      // 仅在验证状态未被其他事件（如离群、点击通过等）更改时进行撤销
      if (verificationEntries.get(key)?.state === captured) {
        dispatchVerification(chatId, userId, { type: "adminCheckResolved" });
      }
    })
    .catch((error: unknown) => {
      logger.error(`Error fetching chat admins for admin-invite exemption in chat ${chatId}:`, error);
    });
}

/**
 * 超时踢人前对拉人者身份的最后核对：缓存热直接判；缓存冷就等一次全量拉取
 * （与在途请求自动合并）。此刻验证状态已被删除，迟到的撤销回调/按钮点击都会
 * 因查不到记录而安全放弃；核对结果以 timeoutInviterVerdict 回投收尾。
 */
async function recheckInviterThenSettle(chatId: number, userId: number, inviterId: number, snapshot: ExpelSnapshot): Promise<void> {
  const cachedAdmins: Set<number> | undefined = freshAdminIds(chatId);
  let inviterIsAdmin: boolean = cachedAdmins?.has(inviterId) === true;
  if (cachedAdmins === undefined) {
    try {
      inviterIsAdmin = (await fetchAdminIds(chatId)).has(inviterId);
    } catch (error: unknown) {
      logger.error(`Error rechecking admin-invite exemption before expiring verification in chat ${chatId}:`, error);
    }
  }
  dispatchVerification(chatId, userId, { type: "timeoutInviterVerdict", inviterIsAdmin, snapshot });
}

/**
 * 超时未验证的最终收尾：删除被追踪的所有消息（入群公告、提醒、TA 等待期间
 * 发送的任何内容），将其踢出聊天，并发布一条通知——此时提到过 TA 的消息都
 * 已被删除，这条通知是关于谁被移除、为何被移除的唯一痕迹。
 */
async function expelMember(chatId: number, userId: number, snapshot: ExpelSnapshot): Promise<void> {
  for (const messageId of snapshot.messageIds) {
    await deleteMessage(chatId, messageId, joinVerificationApi);
  }
  await kickChatMember(chatId, userId, joinVerificationApi);
  const noticeText: string = snapshot.isBot
    ? `啧，${formatMinSec(VERIFICATION_TIMEOUT_MS)} 过去了都没有白名单大人愿意为机器人 ${snapshot.label} 作保，本天才把这个来路不明的铁疙瘩连痕迹一起清出去啦♡`
    : `啧，${snapshot.label} 磨磨蹭蹭 ${formatMinSec(VERIFICATION_TIMEOUT_MS)} 都点不出验证按钮，本天才把 TA 的痕迹清干净、顺手踢出去啦，杂鱼动作太慢咯♡`;
  const noticeMessageId: number | undefined = await sendMessage(chatId, noticeText, undefined, joinVerificationApi);
  if (noticeMessageId !== undefined) {
    deleteMessageAfter(chatId, noticeMessageId, KICK_NOTICE_AUTO_DELETE_MS, joinVerificationApi);
  }
}

// —— 投递 → 验证状态机事件的翻译 ——

/**
 * 处理一条入群投递：预计算状态机需要的同步判定输入（豁免来源、管理员缓存
 * 冷热、暂存的评论），按 joinCreatesNewRecord 决定是否计入刷群统计——
 * recordJoin 可能同步触发私密模式，lockdownActive 必须在它之后取值，越过
 * 阈值的那次入群自己才会被秒踢——然后交给状态机。
 */
function handleJoin(msg: NewMemberMessage): void {
  const { chatId, member } = msg;
  const entryState: VerificationState | undefined = verificationEntries.get(verificationKey(chatId, member.id))?.state;
  const invitedByOther: boolean = msg.actorId !== undefined && msg.actorId !== member.id;
  const event: JoinEvent = {
    type: "join",
    memberId: member.id,
    label: memberLabel(member),
    isBot: member.isBot === true,
    announcementMessageId: msg.announcementMessageId,
    actorId: msg.actorId,
    identityExempt: msg.exempt === true,
    // 管理员拉人免验证的同步快路径：拉人者在特权白名单里，或命中未过期的
    // 管理员表缓存。私密模式期间只认这条同步判定（触发/接管锁定时已预热
    // 缓存），没命中的一律秒踢，不给刷子留验证窗口。
    actorSyncExempt: invitedByOther && (PRIVILEGED_USERS_ID.includes(msg.actorId!) || freshAdminIds(chatId)?.has(msg.actorId!) === true),
    adminCacheFresh: freshAdminIds(chatId) !== undefined,
    lockdownActive: false,
    recentComment: takeRecentComment(chatId, member.id),
    now: Date.now(),
  };
  if (joinCreatesNewRecord(entryState, event)) {
    recordJoin(chatId);
  }
  event.lockdownActive = lockdownEntries.has(chatId);
  dispatchVerification(chatId, member.id, event);
}

/**
 * 处理一条普通群消息投递：先识别关联频道的评论区活动。评论区留言/楼中楼
 * 回复若先于入群更新到达（两个事件的到达顺序不保证），先暂存、入群时消费；
 * 已有验证状态的交给状态机（直接回复频道帖 → 豁免；其余 → 追踪 + 提醒改锚）。
 */
function handleTrackedMessage(msg: TrackedChatMessage): void {
  const inCommentThread: boolean =
    msg.repliesToChannelPost === true ||
    (msg.isThreadReply === true && chatHasLinkedChannel(msg.chatId));
  if (inCommentThread && !verificationEntries.has(verificationKey(msg.chatId, msg.userId))) {
    rememberRecentComment(msg.chatId, msg.userId, msg.messageId, msg.repliesToChannelPost === true);
    return;
  }
  dispatchVerification(msg.chatId, msg.userId, {
    type: "trackedMessage",
    messageId: msg.messageId,
    inCommentThread,
    repliesToChannelPost: msg.repliesToChannelPost === true,
  });
}

/** 处理入群验证按钮的点击：翻译成 callback 事件（谁点的、有没有代点资格）交给状态机。 */
function handleVerificationCallback(msg: VerifyCallbackMessage): void {
  if (msg.chatId === undefined) {
    void answerCallbackQuery(msg.callbackQueryId, undefined, false, joinVerificationApi).catch((error: unknown) => {
      logger.error("Error answering join verification callback:", error);
    });
    return;
  }
  dispatchVerification(msg.chatId, msg.targetUserId, {
    type: "callback",
    callbackQueryId: msg.callbackQueryId,
    isSelf: msg.from.id === msg.targetUserId,
    fromIsPrivileged: PRIVILEGED_USERS_ID.includes(msg.from.id),
    fromLabel: memberLabel(msg.from),
  });
}

// —— 私密模式状态机解释器 ——

/**
 * 把一个事件喂给某群的私密模式状态机并落地结果。thresholdExceeded 的占位
 * 同步生效——recordJoin 调用本函数后，同一批投递里紧随其后的入群立刻就能
 * 在 handleJoin 里看到 lockdownEntries 有记录。
 */
function dispatchLockdown(chatId: number, event: LockdownMachineEvent): void {
  const entry = lockdownEntries.get(chatId);
  const { next, effects } = transitionLockdown(entry?.state, event);
  if (next !== entry?.state) {
    if (next === undefined) {
      if (entry) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        lockdownEntries.delete(chatId);
      }
    } else if (entry) {
      entry.state = next;
    } else {
      lockdownEntries.set(chatId, { state: next, timer: undefined });
    }
  }
  runLockdownEffects(chatId, effects);
}

/** 执行一次私密模式转移返回的副作用（网络请求 fire-and-forget，结果以事件回投）。 */
function runLockdownEffects(chatId: number, effects: LockdownEffect[]): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case "prefetchAdmins":
        if (!effect.onlyIfCold || freshAdminIds(chatId) === undefined) {
          void fetchAdminIds(chatId).catch((error: unknown) => {
            logger.error(`Error prefetching chat admins for lockdown in chat ${chatId}:`, error);
          });
        }
        break;
      case "scheduleRestore": {
        const entry = lockdownEntries.get(chatId);
        if (!entry) break;
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => dispatchLockdown(chatId, { type: "restoreTimerFired" }), effect.delayMs);
        break;
      }
      case "beginApply":
        beginApplyLockdown(chatId, effect.joinCount);
        break;
      case "beginRestore":
        beginRestoreLockdown(chatId, effect.originalPermissions);
        break;
      case "reapplyRestriction":
        reapplyLockdownRestriction(chatId, effect.originalPermissions);
        break;
      case "reportLockdown":
        // 权限已实际落地才回报——镜像里只该出现真正生效了的私密模式，adopt
        // 重放时「恢复原始权限」才不会把从未改过权限的群改坏。
        self.postMessage({ type: "lockdown", chatId, originalPermissions: effect.originalPermissions } satisfies LockdownEvent);
        break;
      case "reportUnlock":
        self.postMessage({ type: "unlock", chatId } satisfies UnlockEvent);
        break;
      case "announceLockdown":
        void sendMessage(
          chatId,
          `哼，${JOIN_WINDOW_MS / 1000} 秒内冲进来了 ${effect.joinCount} 个杂鱼，本天才怀疑是有人在拉人头，先禁止普通成员邀请新人 ${LOCKDOWN_MS / 60_000} 分钟压压惊♡`,
          undefined,
          joinVerificationApi
        );
        break;
      case "announceUnlock":
        void sendMessage(chatId, `${LOCKDOWN_MS / 60_000} 分钟到啦，解除限制，普通成员又能拉人了，杂鱼们悠着点哦♡`, undefined, joinVerificationApi);
        break;
    }
  }
}

/** 私密模式加锁/纠偏共用：在原始权限基础上关掉 can_invite_users，其余字段原样保留。 */
function restrictedPermissions(originalPermissions: ChatPermissions): ChatPermissions {
  return { ...originalPermissions, can_invite_users: false };
}

/**
 * 把一次私密模式相关的 setChatPermissions 调用（加锁/恢复/纠偏）挂到该群的
 * 串行链上：保证这三类调用严格按 dispatch 顺序一个个执行完，不会因为各自
 * 独立发起的网络往返乱序，让后发起的调用比先发起的调用更早/更晚落地在
 * Telegram 上（比如纠偏的加锁比它之后才发起的解锁更晚生效，两者都是各自
 * 独立的 fire-and-forget 调用时就可能发生，见 states/lockdown.ts
 * restoreResult 分支的类头注释）。task 自身兜错，链永不 reject。
 */
function runLockdownApiCall(chatId: number, task: () => Promise<void>): void {
  const prev: Promise<void> = lockdownApiChains.get(chatId) ?? Promise.resolve();
  lockdownApiChains.set(chatId, prev.then(task, task));
}

/**
 * 异步执行加锁：取当前默认权限、把 can_invite_users 关掉，结果以 applyResult
 * 回投。真实刷群下这两个调用可能在限流队列里排几分钟，期间占位状态挡住
 * 重复触发（见状态机注释）。
 */
function beginApplyLockdown(chatId: number, joinCount: number): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    try {
      const chat = await joinVerificationApi.getChat(chatId);
      if (!("permissions" in chat) || !chat.permissions) {
        // permissions 字段对群/超级群实际总会返回，缺失多半是异常响应——
        // 放弃这次锁定（入群验证的逐个踢人仍在兜底），也不能拿 {} 当"原始
        // 权限"存进 ACTIVE：到期恢复会把所有省略字段当 false，整群被永久禁言。
        logger.error(`Chat ${chatId} getChat response missing permissions field, skipping anti-raid lockdown`);
        dispatchLockdown(chatId, { type: "applyResult", ok: false });
        return;
      }
      const originalPermissions: ChatPermissions = chat.permissions;
      await joinVerificationApi.setChatPermissions(chatId, restrictedPermissions(originalPermissions));
      dispatchLockdown(chatId, { type: "applyResult", ok: true, originalPermissions, joinCount });
    } catch (error: unknown) {
      logger.error("Error triggering anti-raid lockdown:", error);
      dispatchLockdown(chatId, { type: "applyResult", ok: false });
    }
  });
}

/** 异步恢复群组原本的默认权限，结果以 restoreResult 回投（失败由状态机安排重试）。 */
function beginRestoreLockdown(chatId: number, originalPermissions: ChatPermissions): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    try {
      await joinVerificationApi.setChatPermissions(chatId, originalPermissions);
      dispatchLockdown(chatId, { type: "restoreResult", ok: true });
    } catch (error: unknown) {
      logger.error(`Failed to restore chat permissions for ${chatId}, retrying shortly:`, error);
      dispatchLockdown(chatId, { type: "restoreResult", ok: false });
    }
  });
}

/**
 * 迟到的旧 beginRestore 成功回执撞上新峰值重新给满的 ACTIVE 时用来纠偏：
 * 原始权限已经在状态里，直接 setChatPermissions 补一次限制，不必再 getChat。
 * 结果不回投状态机——不改变当前 ACTIVE 状态，失败只记日志（best-effort：
 * ACTIVE 到期后自然会走一次常规 beginRestore，届时若权限意外仍是开放的，
 * 后续峰值触发的 thresholdExceeded 也会在下次滑窗超限时重新收紧）。挂在同一
 * 条 runLockdownApiCall 串行链上，保证不会比它之后才发起的一次恢复更晚落地。
 */
function reapplyLockdownRestriction(chatId: number, originalPermissions: ChatPermissions): void {
  runLockdownApiCall(chatId, async (): Promise<void> => {
    try {
      await joinVerificationApi.setChatPermissions(chatId, restrictedPermissions(originalPermissions));
    } catch (error: unknown) {
      logger.error(`Error reapplying anti-raid restriction for chat ${chatId} after a stale restore succeeded:`, error);
    }
  });
}

/**
 * 记录一次已确认的新成员加入（由 handleJoin 按 joinCreatesNewRecord 去重后
 * 调用）。滑动窗口：最近 JOIN_WINDOW_MS 内的入群人数超过阈值即触发临时
 * 私密模式——不用「首次入群起算、到点整体清零」的固定桶，是为了防住横跨
 * 桶边界的刷群（前桶尾 + 后桶头各塞半个阈值，固定桶永远数不满）。
 */
function recordJoin(chatId: number): void {
  const now: number = Date.now();
  let window = joinWindows.get(chatId);
  if (!window) {
    window = { timestamps: [], resetTimeout: setTimeout(() => joinWindows.delete(chatId), JOIN_WINDOW_MS) };
    joinWindows.set(chatId, window);
  } else {
    // 清理计时器在每次入群时重置：它到期即意味着窗口静默满 JOIN_WINDOW_MS，
    // 届时所有时间戳都已过期，整个条目可以安全删除。
    clearTimeout(window.resetTimeout);
    window.resetTimeout = setTimeout(() => joinWindows.delete(chatId), JOIN_WINDOW_MS);
  }

  const cutoff: number = now - JOIN_WINDOW_MS;
  while (window.timestamps.length > 0 && window.timestamps[0]! <= cutoff) {
    window.timestamps.shift();
  }
  window.timestamps.push(now);

  if (window.timestamps.length > JOIN_THRESHOLD) {
    dispatchLockdown(chatId, { type: "thresholdExceeded", joinCount: window.timestamps.length });
  }
}

/** 接管上一个（已崩溃的）Worker / 上一个进程留下的私密模式（背景见 antiRaid.ts）。 */
function adoptLockdowns(lockdowns: AdoptableLockdown[]): void {
  for (const { chatId, originalPermissions, remainingMs } of lockdowns) {
    dispatchLockdown(chatId, { type: "adopt", originalPermissions, remainingMs });
  }
}

self.onmessage = (event: MessageEvent<AntiRaidWorkerMessage>) => {
  const msg: AntiRaidWorkerMessage = event.data;
  switch (msg.type) {
    case "join":
      handleJoin(msg);
      break;
    case "left":
      dispatchVerification(msg.chatId, msg.userId, { type: "left" });
      break;
    case "message":
      handleTrackedMessage(msg);
      break;
    case "callback":
      handleVerificationCallback(msg);
      break;
    case "adopt":
      adoptLockdowns(msg.lockdowns);
      break;
    case "adminsChanged":
      applyAdminChange(msg.chatId, msg.userId, msg.isAdmin);
      break;
  }
};
