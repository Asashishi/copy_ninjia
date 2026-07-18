import { logger } from "../../infra/logger";
import { InlineKeyboard } from "grammy";
import {
  sendMessage,
  deleteMessage,
  deleteMessageAfter,
  kickChatMember,
  answerCallbackQuery,
  joinVerificationApi,
} from "../../infra/telegram";
import { formatUserLabel } from "../../users/userLabel";
import { formatMinSec } from "../../libs/time";
import { KICK_NOTICE_AUTO_DELETE_MS } from "../../consts/telegram";
import { PRIVILEGED_USERS_ID } from "../../infra/config";
import {
  LOCKDOWN_KICK_DEDUPE_MS,
  VERIFICATION_BUTTON_TEXT,
  VERIFICATION_TIMEOUT_MS,
  VERIFY_CALLBACK_PREFIX,
  WELCOME_AUTO_DELETE_MS,
} from "../../consts/antiRaid";
import { lockdownEntries, verificationEntries } from "../../cache/antiRaidWorker";
import type { AntiRaidMember, NewMemberMessage, TrackedChatMessage, VerifyCallbackMessage } from "../../types";
import {
  joinCreatesNewRecord,
  transitionVerification,
  type ExpelSnapshot,
  type JoinEvent,
  type VerificationEffect,
  type VerificationEvent,
  type VerificationState,
} from "../../states/verification";
import { verificationKey } from "./keys";
import { fetchAdminIds, freshAdminIds } from "./adminCache";
import { rememberRecentComment, takeRecentComment } from "./recentComments";
import { chatHasLinkedChannel } from "./linkedChannel";
import { recordJoin, retractJoin } from "./lockdownRuntime";

/**
 * 入群验证状态机（src/states/verification.ts）的解释器：把每条投递翻译成
 * 状态机事件、同步落下一状态、管理计时器、把返回的副作用列表逐个执行。
 * 所有「哪些标志组合走哪条分支」的判定都在状态机的纯转移函数里，这里只剩
 * I/O 与线程胶水。关键约定：
 * - dispatch 里状态更替是同步的，副作用（网络请求）一律事后执行——消息
 *   按 FIFO 逐条处理，同一波刷屏入群的后续投递不会被网络往返卡住。
 * - 异步回调（提醒落地回填、管理员核查）以「状态对象同一性」识别过期：
 *   状态一旦被替换/删除，捕获的旧引用对不上，回调自动放弃。
 * 验证状态随线程丢失，不回报主线程持久化（残留的验证按钮点了会得到
 * 「已失效」应答，重新进群即可）；总体架构见 ../antiRaidWorker.ts 模块头。
 */

function memberLabel(member: AntiRaidMember): string {
  return formatUserLabel({ id: member.id, username: member.username, first_name: member.first_name });
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
export function dispatchVerification(chatId: number, userId: number, event: VerificationEvent): void {
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
      case "retractJoinCount":
        retractJoin(chatId, effect.joinedAt);
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
        if (entry?.state.kind === "pending") {
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
  if (captured?.kind !== "pending") return;
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
  if (captured?.kind !== "pending") return;
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
 * 踢人失败（典型是机器人缺封禁权限）时通知照发但如实说没踢动，且不自动
 * 删除——人还在群里，宣布"已踢出"就是当众撒谎。
 */
async function expelMember(chatId: number, userId: number, snapshot: ExpelSnapshot): Promise<void> {
  for (const messageId of snapshot.messageIds) {
    await deleteMessage(chatId, messageId, joinVerificationApi);
  }
  const kicked: boolean = await kickChatMember(chatId, userId, joinVerificationApi);
  // 踢没踢动要老实说：缺封禁权限时人还留在群里，照旧宣布"已踢出"就是
  // 当众撒谎，管理员也不会意识到该去补机器人权限。
  const noticeText: string = !kicked
    ? `啧，${snapshot.label} 超时没验证，本天才本想把 TA 踢出去，结果居然没踢动……肯定是哪个杂鱼管理员没给本天才封禁权限！快去检查，不然只能你们自己动手请 TA 出去咯♡`
    : snapshot.isBot
    ? `啧，${formatMinSec(VERIFICATION_TIMEOUT_MS)} 过去了都没有白名单大人愿意为机器人 ${snapshot.label} 作保，本天才把这个来路不明的铁疙瘩连痕迹一起清出去啦♡`
    : `啧，${snapshot.label} 磨磨蹭蹭 ${formatMinSec(VERIFICATION_TIMEOUT_MS)} 都点不出验证按钮，本天才把 TA 的痕迹清干净、顺手踢出去啦，杂鱼动作太慢咯♡`;
  const noticeMessageId: number | undefined = await sendMessage(chatId, noticeText, undefined, joinVerificationApi);
  // 没踢动的战报不自动删：它是要管理员去补权限的行动提示，30 秒就消失的话
  // 多半没人看见，权限缺口会一直留着。
  if (noticeMessageId !== undefined && kicked) {
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
export function handleJoin(msg: NewMemberMessage): void {
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
    // 传入 event.now 而不是让 recordJoin 自己再取一次 Date.now()：这个值
    // 同时也会存进 PendingState.joinedAt（见 states/verification.ts 的
    // handleJoin），retractJoin 撤销计数时要按值精确匹配这条时间戳，两处
    // 若各自现取时间会因几步执行的间隔产生毫秒级偏差，导致按值查找落空。
    recordJoin(chatId, event.now);
  }
  event.lockdownActive = lockdownEntries.has(chatId);
  dispatchVerification(chatId, member.id, event);
}

/**
 * 处理一条普通群消息投递：先识别关联频道的评论区活动。评论区留言/楼中楼
 * 回复若先于入群更新到达（两个事件的到达顺序不保证），先暂存、入群时消费；
 * 已有验证状态的交给状态机（直接回复频道帖 → 豁免；其余 → 追踪 + 提醒改锚）。
 */
export function handleTrackedMessage(msg: TrackedChatMessage): void {
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
export function handleVerificationCallback(msg: VerifyCallbackMessage): void {
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
