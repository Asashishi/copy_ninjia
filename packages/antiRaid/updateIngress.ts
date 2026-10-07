import { chatAtmosphere } from "../infra/atmosphere";
import type { Context } from "grammy";
import type {
  CallbackQuery,
  Chat,
  ChatMemberUpdated,
  Message,
  User,
} from "grammy/types";
import { logger } from "../infra/logger";
import { recordJoinLog } from "../infra/joinLog";
import { answerCallbackQuery } from "../infra/telegram/actions";
import {
  cachedBotAdminStatus,
  resolveBotAdminStatus,
  markBotAdminObserved,
} from "../infra/botAdmin";
import { VERIFY_APPROVE_CALLBACK_PREFIX, VERIFY_SELF_CALLBACK_PREFIX } from "../consts/antiRaid/verification";

import { isAdminStatus, isPresentMember } from "../libs/chatMember";
import { verificationKey } from "../libs/verificationKey";
import { hasUserMessageContent } from "../users/messageContent";
import { activeVerificationSnapshots } from "../cache/main/antiRaid/verificationMirror";
import { adCandidatePostRejected } from "../cache/main/antiRaid/proxy";
import { getChatState } from "../infra/storage/stateStore";
import { updateNow } from "../infra/updateContext";
import { adDetectionSenderId, buildAdCandidate } from "./adCandidate";
import { visibleSenderChat } from "../users/visibleSender";
import { observeChatKind } from "./chatKind";
import {
  claimBlockedJoiner,
  deleteBlockedSenderChatMessage,
} from "./blocklistGuard";
import { buildFloodCandidate } from "./floodControl";
import {
  isInviterExemptAdmin,
  pickMember,
} from "./memberFacts";
import { postAntiRaidDurably } from "./durableDelivery";
import { parseUserIdArgument } from "../libs/telegramId";
import { postAntiRaid } from "./workerBridge/controller";
import { recordEligibleTemporaryAdBypassActivity } from "./temporaryAdBypass";
import type {
  AdCandidateMessage,
  AdDetectionMessageContext,
} from "../types/antiRaid/adDetect";
import type {
  AntiRaidWorkerMessage,
  FloodCandidateMessage,
} from "../types/antiRaid/protocol";
import type { ChatState } from "../types/chatState";
import { TELEGRAM_DATE_UNIT_MS } from "../consts/telegram";

/**
 * 处理 `chat_member` 更新：入群/离群的权威信号（`new_chat_members`/`left_chat_member`
 * 服务消息在群组隐藏入群/离群消息时不会发送）。接收非机器人自身成员的 chat_member
 * 更新要求机器人是群管理员。
 */
export async function handleChatMemberUpdate(ctx: Context): Promise<void> {
  const update: ChatMemberUpdated | undefined = ctx.chatMember;
  if (!update) return;

  const chatId: number = update.chat.id;
  // 群类型镜像只收已接管群；只有主线程看得见 chat.type，而踢人在 Worker 里
  // 按它分派方法（见 ./chatKind.ts）。按值去重，每次类型变化只投一条。
  observeChatKind(update.chat);
  const user: User = update.new_chat_member.user;
  // 机器人自身的成员变动走 my_chat_member；本排除位于 markBotAdminObserved 之前，
  // 因为该观测以「更新是关于别人的」为前提。
  if (user.id === ctx.me.id) return;

  // 收到别人的 chat_member 更新即说明机器人此刻是本群管理员，据此记录（见 botAdmin.ts）；
  // 本路径不做非管理员门控。
  await markBotAdminObserved(chatId);

  // 入群守卫的总开关（`/antiraid`）。关着的群仍然记入群日志、仍然按黑名单秒踢
  // ——那两件事各自独立（`/batch_kick` 的依据、永久名单），只有验证窗口与私密
  // 模式这条链路跟着它一起停（见 types/chatState.ts 的 isAntiRaidEnabled）。
  const joinGuardEnabled: boolean = getChatState(chatId).isAntiRaidEnabled === true;

  // 机器人同样走验证——僵尸 bot 也会被批量拉进群刷屏，由本群管理员代点「通过」作保。
  const wasActive: boolean = isPresentMember(update.old_chat_member);
  const isActive: boolean = isPresentMember(update.new_chat_member);

  // 管理员任免、入离群及匿名模式切换同样以 chat_member 更新送达：同步给
  // Worker 侧的邀请者豁免缓存，让「非匿名管理员拉人免验证」的同步判定
  // 近乎实时，缓存 TTL 只是兜底。FIFO 保证它先于随后的 join/left 投递生效。
  const isAdmin: boolean = isAdminStatus(update.new_chat_member.status);
  const wasInviterExempt: boolean =
    isInviterExemptAdmin(update.old_chat_member);
  const isInviterExempt: boolean =
    isInviterExemptAdmin(update.new_chat_member);
  const messages: AntiRaidWorkerMessage[] = [];
  // 这一条不受开关门控：applyAdminChange 只改邀请者豁免缓存、不碰状态机，守卫关着时
  // 投过去没有副作用；缓存条目按 fetchedAt 判过期，applyAdminChange 不刷新它
  // （见 workers/antiRaid/adminCache.ts）。
  if (wasInviterExempt !== isInviterExempt) {
    messages.push({
      type: "adminsChanged",
      chatId,
      userId: user.id,
      isInviterExempt,
    });
  }

  const replacedJoins: Map<number, AntiRaidWorkerMessage> = new Map();
  if (!wasActive && isActive) {
    // Telegram 事件自带时间戳作为幂等 key 的一部分；落盘 Worker 在写前
    // 按用户最新记录去重。入群事实进批次即受理；未确认镜像已满或 Disk I/O 拒收时
    // 抛错让 update 失败重投。
    if (!recordJoinLog({
      chatId,
      userId: user.id,
      joinedAt: update.date * TELEGRAM_DATE_UNIT_MS,
    })) {
      throw new Error(
        `Join log persistence refused the event for chat ${chatId}, user ${user.id}.`
      );
    }
    // 以管理员/群主身份入群的免验证。身份只有本路径可见（new_chat_members
    // 服务消息里没有），因此带 exempt 标记投给 Worker：服务消息那一路已开了
    // 验证窗口时，Worker 收到豁免后撤销它。
    const joinMessage: AntiRaidWorkerMessage | undefined = joinGuardEnabled
      ? {
        type: "join",
        chatId,
        member: pickMember(user),
        exempt: isAdmin,
        actorId: update.from.id,
      }
      : undefined;
    // 黑名单优先于一切豁免，且取代 join 投递。
    // 这一路没有入群公告（chat_member 更新不带服务消息），刷群计数由处置消息补记。
    // 被取代的 join 一并登记：处置在 durable 对账里被 /block disable 取消时改投它
    // （见 blocklistDelivery.ts）。
    if (!claimBlockedJoiner({
      chatId,
      userId: user.id,
      messages,
      replacedJoin: joinMessage,
      replacedJoins,
      joinGuardEnabled,
    }) && joinMessage !== undefined) {
      messages.push(joinMessage);
    }
  } else if (wasActive && !isActive && joinGuardEnabled) {
    messages.push({ type: "left", chatId, userId: user.id });
  }
  if (messages.length > 0) {
    await postAntiRaidDurably(messages, replacedJoins);
  }
}

/**
 * 消息事件的投递入口，在 app/registerHandlers.ts 里以中间件形式挂在所有
 * 命令处理器之前，待验证用户发的命令消息（/copy 之类）也计入刷屏窗口。职责：在群组
 * 未隐藏 `new_chat_members`/`left_chat_member` 服务消息时顺带捕获它们，并把
 * 每条消息的（chatId, userId, messageId）投递给 Worker；messageId 只用于回复式
 * 提醒和频道评论豁免锚点，不会在纯 kick 时用于删除成员发言。
 * 入群/离群本身的检测由 handleChatMemberUpdate 驱动——与这些服务消息
 * 不同，它总是会触发。
 * @returns 若消息在此已被完全处理、调用方应跳过后续处理逻辑（入群公告），
 * 为 true；否则为 false，让消息正常继续流转。稳定态（管理员身份已确证、非
 * 服务消息、非黑名单频道身份）**同步**返回 false，不分配 Promise；只有现查
 * 管理员身份、删除黑名单频道消息或 durable 投递这三种情形返回 Promise，
 * 调用方按 MaybePromise 处理（见 app/registerHandlers.ts 的 claimOrContinue）。
 */
export function handleAntiRaidMessageIngress(
  message: Message,
  botId: number
): boolean | Promise<boolean> {
  // 验证只发生在群聊里，私聊直接放行。
  if (message.chat?.type === "private") return false;

  // 已接管群的类型镜像（见 ./chatKind.ts）排在管理员门禁之前；未接管群不占用镜像。
  observeChatKind(message.chat);

  // 机器人不是本群管理员时整个入群守卫不启动，不投递；入群公告照样吞掉
  // （服务消息不进复读/AI 流水线）。
  //
  // 已确证过的群同步读现值（cachedBotAdminStatus），`undefined` 才现查
  // （resolveBotAdminStatus）；两条路判定的是同一份权限快照。
  const knownAdmin: boolean | undefined = cachedBotAdminStatus(message.chat.id);
  if (knownAdmin !== undefined) {
    return knownAdmin
      ? ingestAdminChatMessage(message, botId)
      : isSwallowedJoinAnnouncement(message);
  }
  return resolveBotAdminStatus(message.chat.id).then(
    (isAdmin: boolean): boolean | Promise<boolean> => isAdmin
      ? ingestAdminChatMessage(message, botId)
      : isSwallowedJoinAnnouncement(message)
  );
}

/**
 * 非管理员群里唯一还要做的事：把入群公告吞掉，不让它进复读/AI 流水线。
 * 判据与本文件下面那处 `new_chat_members` 分支逐字一致。
 */
function isSwallowedJoinAnnouncement(message: Message): boolean {
  return !!(message.new_chat_members && message.new_chat_members.length > 0);
}

/**
 * 广告候选投递结果的边沿日志：Worker 重建或已放弃自愈期间每条开着广告检测的群消息都会
 * 被拒，只在由收转拒时记一行错误、由拒转收时记一行恢复（见 adCandidatePostRejected）。
 */
function noteAdCandidatePost(chatId: number, posted: boolean): void {
  if (posted) {
    if (adCandidatePostRejected.current) {
      adCandidatePostRejected.current = false;
      logger.log("Anti-Raid Worker accepts ad detection candidates again.");
    }
    return;
  }
  if (adCandidatePostRejected.current) return;
  adCandidatePostRejected.current = true;
  logger.error(
    `Anti-Raid Worker rejected an ad detection candidate from chat ${chatId}; ` +
    "further rejections are not logged until a candidate is accepted again."
  );
}

/**
 * 已确证机器人是本群管理员之后的那一段。黑名单频道消息在这里就地删除；
 * 常态下它同步返回 false，只有真要删一条消息时才产生 Promise。
 */
function ingestAdminChatMessage(
  message: Message,
  botId: number
): boolean | Promise<boolean> {
  // 永久黑名单不依赖广告开关、模型密钥或样本配置。频道身份没有
  // banChatMember.revoke_messages 可用，仍漏进来的消息在公共入口就地删除；
  // 真人用户由在途 banChatMember 的服务端撤回处理。
  const blocked: boolean | Promise<boolean> =
    deleteBlockedSenderChatMessage(message);
  if (typeof blocked !== "boolean") {
    return blocked.then((claimed: boolean): boolean | Promise<boolean> =>
      claimed ? true : ingestAdmittedMessage(message, botId));
  }
  return blocked ? true : ingestAdmittedMessage(message, botId);
}

/**
 * 黑名单门禁放行之后的投递段：广告候选、入群/离群服务消息、刷屏计数与
 * 频道评论线索。同步门禁全部不命中时同步返回 false，不分配 Promise。
 */
function ingestAdmittedMessage(
  message: Message,
  botId: number
): boolean | Promise<boolean> {
  const chatState: Readonly<ChatState> = getChatState(message.chat.id);
  if (
    message.new_chat_members &&
    message.new_chat_members.length > 0
  ) {
    // 入群守卫关着时这一路只剩黑名单秒踢：不开验证窗口、不记入群计数；公告
    // 照样吞掉（与守卫开关无关）。
    const joinGuardEnabled: boolean = chatState.isAntiRaidEnabled === true;
    const messages: AntiRaidWorkerMessage[] = [];
    const replacedJoins: Map<number, AntiRaidWorkerMessage> = new Map();
    for (const member of message.new_chat_members) {
      // 机器人同样走验证（由本群管理员代点「通过」作保），只跳过本机器人自己。
      if (member.id === botId) continue;
      const joinMessage: AntiRaidWorkerMessage | undefined = joinGuardEnabled
        ? {
          type: "join",
          chatId: message.chat.id,
          member: pickMember(member),
          announcementMessageId: message.message_id,
          actorId: message.from?.id,
        }
        : undefined;
      // 与 chat_member 那一路会为同一次入群各投一次处置（重复 ban 幂等）。
      if (claimBlockedJoiner({
        chatId: message.chat.id,
        userId: member.id,
        messages,
        replacedJoin: joinMessage,
        replacedJoins,
        // 服务消息这一路带得到入群公告，交给处置一并删。
        announcementMessageId: message.message_id,
        joinGuardEnabled,
      })) {
        continue;
      }
      if (joinMessage !== undefined) messages.push(joinMessage);
    }
    if (messages.length > 0) {
      return postAntiRaidDurably(messages, replacedJoins).then((): boolean => true);
    }
    return true;
  }

  if (message.left_chat_member) {
    // left 只用来撤销这个人的验证窗口；守卫关着时没有窗口可撤。
    if (chatState.isAntiRaidEnabled === true) {
      return postAntiRaidDurably([{
        type: "left",
        chatId: message.chat.id,
        userId: message.left_chat_member.id,
      }]).then((): boolean => false);
    }
    return false;
  }

  // 临时广告免检累计先于候选构建：本条消息恰好让成员获权时，
  // buildAdCandidate 立即读到临时广告绕过权限，不再送检。投递尽力而为。
  // 两者共同的前置判定（开关、配置、自动转发、自发消息与展示身份）只做一次。
  let adCandidate: AdCandidateMessage | undefined;
  if (chatState.isAdDetectEnabled === true) {
    const senderChat: Chat | undefined = visibleSenderChat(message);
    const adSenderId: number | undefined = adDetectionSenderId(message, botId, senderChat);
    if (adSenderId !== undefined) {
      const adContext: AdDetectionMessageContext = {
        message,
        botId,
        // 与自动流水线主干共用本条 update 的同一次时钟读取（见 infra/updateContext.ts）。
        now: updateNow(),
        senderId: adSenderId,
        senderChat,
      };
      if (hasUserMessageContent(message)) {
        recordEligibleTemporaryAdBypassActivity(adContext);
      }
      adCandidate = buildAdCandidate(adContext);
    }
  }
  if (adCandidate !== undefined) noteAdCandidatePost(message.chat.id, postAntiRaid(adCandidate));

  // 刷屏计数投递：与广告检测同一形态，主线程只做同步门禁 + 一次尽力而为的
  // post，窗口与禁言都在 Worker 侧（见 workers/antiRaid/floodControl.ts）。排在
  // 服务消息两条分支之后，入群/离群公告不计入窗口。
  // 无论开关如何，先读取本条 update 的时刻（updateNow）供后续自动流水线复用；
  // 普通群和未开刷屏的群跳过候选函数及其入参对象。
  const now: number = updateNow();
  const floodCandidate: FloodCandidateMessage | undefined =
    message.chat.type === "supergroup" && chatState.isFloodControlEnabled === true
      ? buildFloodCandidate({ message, botId, now, chatState })
      : undefined;
  if (floodCandidate !== undefined) {
    // 投递被拒不记日志，与广告检测那条不同：post 返回 false 只发生在 Worker 正在
    // 重建或已放弃重建时（后者由 supervisor 带 giveUpConsequence 记录），丢掉的只是计数。
    postAntiRaid(floodCandidate);
  }

  const userId: number | undefined = message.from?.id;
  // message_thread_id 有两个来源：关联频道讨论组的评论线程，和论坛（topics）
  // 群里的话题；只有评论线程可能是「评论早于 join 更新到达」的候选，
  // 论坛话题消息（is_topic_message）排除。
  const isCommentThreadReply: boolean =
    message.message_thread_id !== undefined &&
    message.is_topic_message !== true;
  const mayPrecedeJoinInCommentThread: boolean =
    message.reply_to_message?.is_automatic_forward === true ||
    isCommentThreadReply;
  if (userId === undefined) return false;
  // 先看表空不空再拼键，空表时跳过复合键构造。
  const senderPending: boolean =
    activeVerificationSnapshots.size > 0 &&
    activeVerificationSnapshots.has(verificationKey(message.chat.id, userId));
  if (
    !(senderPending || mayPrecedeJoinInCommentThread) ||
    // 排在最后：守卫关着的群没有验证窗口，不需要这条投递。
    chatState.isAntiRaidEnabled !== true
  ) {
    return false;
  }
  // 附带频道评论区的识别线索：评论与楼中楼回复都代表 TA 已实际参与讨论，
  // Worker 据此免除验证且不计入刷群窗口。没有任何评论区消息的普通入群
  // 照常验证，超时仍会被踢出。
  const workerMessage: AntiRaidWorkerMessage = {
    type: "message",
    chatId: message.chat.id,
    userId,
    messageId: message.message_id,
    repliesToChannelPost:
      message.reply_to_message?.is_automatic_forward === true,
    isThreadReply: isCommentThreadReply,
  };
  // 待验证成员的消息会改写验证镜像，必须经 durable 投递落盘后才确认本条 update。
  if (senderPending) return postAntiRaidDurably([workerMessage]).then((): boolean => false);
  // 其余只是评论区线索：Worker 只记进内存；端口 FIFO 保证它先于之后的入群消息到达。
  // 投递被拒不记日志，口径同上面的刷屏计数。
  postAntiRaid(workerMessage);
  return false;
}

/**
 * 处理入群验证按钮的点击（callback_query）：按前缀分辨本人验证与「通过」，
 * 解析出目标成员后整体投递给 Worker 应答与处理；「通过」的管理员身份由
 * Worker 侧的本群管理员缓存判定。前缀不匹配的 callback_query 与本模块无关，
 * 直接放过。
 */
export async function handleVerificationCallback(
  ctx: Context
): Promise<void> {
  const query: CallbackQuery | undefined = ctx.callbackQuery;
  const data: string | undefined = query?.data;
  if (!query || data === undefined) return;
  let action: "self" | "approve";
  let prefixLength: number;
  if (data.startsWith(VERIFY_SELF_CALLBACK_PREFIX)) {
    action = "self";
    prefixLength = VERIFY_SELF_CALLBACK_PREFIX.length;
  } else if (data.startsWith(VERIFY_APPROVE_CALLBACK_PREFIX)) {
    action = "approve";
    prefixLength = VERIFY_APPROVE_CALLBACK_PREFIX.length;
  } else {
    return;
  }

  // 守卫已关的群里可能留着没被删掉的旧按钮：当场应答并提示，不投给 Worker。
  const callbackChatId: number | undefined = query.message?.chat.id;
  if (
    callbackChatId !== undefined &&
    getChatState(callbackChatId).isAntiRaidEnabled !== true
  ) {
    await answerCallbackQuery({
      callbackQueryId: query.id,
      text: chatAtmosphere().VERIFICATION_GUARD_DISABLED_CALLBACK_TEXT,
      showAlert: true,
    });
    return;
  }

  // callback_data 属于外部输入，前缀匹配不代表后半段是合法整数；与命令参数共用同一道
  // 严格十进制判定（见 libs/telegramId.ts 的 parseUserIdArgument），
  // `"1e3"`、`" 12"` 这类非规范写法不放行。
  const targetUserId: number | undefined = parseUserIdArgument(data.slice(prefixLength));
  if (targetUserId === undefined) {
    await answerCallbackQuery({
      callbackQueryId: query.id,
      text: chatAtmosphere().VERIFICATION_INVALID_CALLBACK_TEXT,
      showAlert: true,
    });
    return;
  }

  await postAntiRaidDurably([{
    type: "callback",
    callbackQueryId: query.id,
    chatId: query.message?.chat.id,
    targetUserId,
    action,
    from: pickMember(query.from),
  }]);
}
