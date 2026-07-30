import type { Context } from "grammy";
import type {
  CallbackQuery,
  ChatMemberUpdated,
  Message,
  User,
} from "@grammyjs/types";
import { logger } from "../infra/logger";
import { answerCallbackQuery } from "../infra/telegram/actions";
import {
  ensureBotChatPermissions,
  isBotAdminIn,
  markBotAdminObserved,
} from "../infra/botAdmin";
import { VERIFY_CALLBACK_PREFIX } from "../consts/antiRaid/verification";
import { isAdminStatus } from "../libs/chatMember";
import { verificationKey } from "../libs/verificationKey";
import { activeVerificationSnapshots } from "../cache/main/antiRaid/verificationMirror";
import { isWhitelisted } from "../config/whitelist";
import { buildAdCandidate } from "./adDetect";
import { claimBlockedJoiner } from "./blocklistGuard";
import { buildFloodCandidate } from "./floodControl";
import {
  isActiveChatMember,
  isInviterExemptAdmin,
  pickMember,
} from "./memberFacts";
import { postAntiRaidDurably } from "./durableDelivery";
import { postAntiRaid } from "./workerBridge";
import type {
  AdCandidateMessage,
  AntiRaidWorkerMessage,
  FloodCandidateMessage,
} from "../types/antiRaid";

/**
 * 处理 `chat_member` 更新：这是权威且始终会送达的入群/离群信号（不同于
 * `new_chat_members`/`left_chat_member` 服务消息——一旦群组开启了"隐藏入群/
 * 离群消息"，这些服务消息就完全不会再发送）。要接收非机器人自身成员的这类
 * 更新，需要机器人是群管理员——而封禁/删除消息本来也需要这个权限。
 */
export async function handleChatMemberUpdate(ctx: Context): Promise<void> {
  const update: ChatMemberUpdated | undefined = ctx.chatMember;
  if (!update) return;

  const chatId: number = update.chat.id;
  const user: User = update.new_chat_member.user;
  // 自身的成员变动本来走 my_chat_member；这条排除必须放在最前面——万一
  // Telegram 真的也为机器人自己送来一条 chat_member（比如这次恰好就是自己
  // 被撤管理员），排在下面 markBotAdminObserved 之后会被误判：那条推理
  // （"收到别人的 chat_member 就证明自己此刻是管理员"）建立在"这是关于
  // 别人的更新"之上，套在这条报告自己被撤权的更新上会得出恰好相反的结论。
  if (user.id === ctx.me.id) return;

  // 能收到别人的 chat_member 更新，本身就证明机器人此刻是本群管理员——
  // 顺手记录（见 botAdmin.ts），这条路径无需（也不能）做非管理员门控：
  // 不是管理员时这类更新根本不会送达。
  await markBotAdminObserved(chatId);

  // 机器人不再豁免——僵尸 bot 也会被批量拉进群刷屏，照常走验证（由白名单
  // 用户代点按钮作保）。
  const wasActive: boolean = isActiveChatMember(update.old_chat_member);
  const isActive: boolean = isActiveChatMember(update.new_chat_member);

  // 管理员任免、入离群及匿名模式切换同样以 chat_member 更新送达：同步给
  // Worker 侧的邀请者豁免缓存，让「非匿名管理员拉人免验证」的同步判定
  // 近乎实时，缓存 TTL 只是兜底。FIFO 保证它先于随后的 join/left 投递生效。
  const isAdmin: boolean = isAdminStatus(update.new_chat_member.status);
  const wasInviterExempt: boolean =
    isInviterExemptAdmin(update.old_chat_member);
  const isInviterExempt: boolean =
    isInviterExemptAdmin(update.new_chat_member);
  const messages: AntiRaidWorkerMessage[] = [];
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
    // 以管理员/群主身份入群的（典型如群主退群重进）免验证。身份只有本路径
    // 可见，new_chat_members 服务消息里没有——所以不能简单跳过不投递，而要
    // 带 exempt 标记投给 Worker：若服务消息那一路已抢先开了验证窗口，Worker
    // 收到豁免后会将其撤销。
    const joinMessage: AntiRaidWorkerMessage = {
      type: "join",
      chatId,
      member: pickMember(user),
      exempt: isAdmin,
      actorId: update.from.id,
      actorIsWhitelisted: isWhitelisted(update.from.id),
    };
    // 黑名单优先于一切豁免，且取代 join 投递：Worker 不会为一个马上要被踢掉的人开窗口。
    // 这一路没有入群公告（chat_member 更新不带服务消息），刷群计数由处置消息补记。
    // 被取代的 join 一并登记：处置在 durable 对账里被 /unblock 取消掉时改投它，
    // 否则这个人既没有移除也没有验证窗口（见 blocklistDelivery.ts）。
    if (!claimBlockedJoiner({
      chatId,
      userId: user.id,
      messages,
      replacedJoin: joinMessage,
      replacedJoins,
    })) {
      messages.push(joinMessage);
    }
  } else if (wasActive && !isActive) {
    messages.push({ type: "left", chatId, userId: user.id });
  }
  if (messages.length > 0) {
    await postAntiRaidDurably(messages, replacedJoins);
  }
}

/**
 * 消息事件的投递入口，在 app/registerHandlers.ts 里以中间件形式挂在所有
 * 命令处理器之前
 * ——这样待验证用户发的命令消息（/copy 之类）也会被追踪，超时踢人时
 * 一并清理，不给刷群脚本留「刷命令就删不掉」的空子。职责：在群组未隐藏
 * `new_chat_members`/`left_chat_member` 服务消息时顺带捕获它们（以便这些
 * 消息的 ID 也能被 Worker 追踪/清理），同时把每条消息的（chatId, userId,
 * messageId）投递给 Worker，用于追踪待验证用户在等待期间发送的消息。
 * 入群/离群本身的检测由 handleChatMemberUpdate 驱动——与这些服务消息
 * 不同，它总是会触发。
 * @returns 若消息在此已被完全处理、调用方应跳过后续处理逻辑（入群公告），
 * 返回 true；否则返回 false，让消息正常继续流转。
 */
export async function handleGroupJoinVerification(
  message: Message,
  botId: number
): Promise<boolean> {
  // 验证只发生在群聊里，私聊消息不必跨线程投递去查一次注定落空的 Map。
  if (message.chat?.type === "private") return false;

  // 机器人不是本群管理员时整个入群守卫不启动：踢人/删消息都做不了，投递
  // 过去只会让 Worker 开一堆注定失败的验证窗口、刷一堆权限报错。已有身份
  // 记录时这个判定是同步的（不打 API），只有从未记录过的群会现查一次。
  // 入群公告照样吞掉（服务消息本来就不该流进复读/AI 流水线），只是不投递。
  if (!(await isBotAdminIn(message.chat.id))) {
    return !!(
      message.new_chat_members &&
      message.new_chat_members.length > 0
    );
  }

  // 广告检测与入群守卫共用上面那道管理员判定：不是管理员就删不掉广告也封不了
  // 人，判一次纯属白烧额度。投递是尽力而为的——Worker 不可用只意味着它正在
  // 重建，而待检队列本来就随 isolate 一起清空，不值得为它拒收这条 update。
  const adCandidate: AdCandidateMessage | undefined =
    buildAdCandidate(message, botId);
  if (adCandidate !== undefined && !postAntiRaid(adCandidate)) {
    logger.error(
      `Anti-Raid Worker rejected an ad detection candidate from chat ${message.chat.id}.`
    );
  }

  if (
    message.new_chat_members &&
    message.new_chat_members.length > 0
  ) {
    const messages: AntiRaidWorkerMessage[] = [];
    const replacedJoins: Map<number, AntiRaidWorkerMessage> = new Map();
    for (const member of message.new_chat_members) {
      // 机器人不再豁免（走白名单用户代点验证的流程），只跳过本天才自己
      // ——自己既不能验证自己，也不该被自己踢出去。
      if (member.id === botId) continue;
      const joinMessage: AntiRaidWorkerMessage = {
        type: "join",
        chatId: message.chat.id,
        member: pickMember(member),
        announcementMessageId: message.message_id,
        actorId: message.from?.id,
        actorIsWhitelisted:
          message.from !== undefined &&
          isWhitelisted(message.from.id),
      };
      // 与 chat_member 那一路会为同一次入群各投一次处置；重复 ban 幂等，但两条都要拦
      // ——隐藏入群消息的群只有 chat_member 会到，而 chat_member 又要管理员权限才送达。
      if (claimBlockedJoiner({
        chatId: message.chat.id,
        userId: member.id,
        messages,
        replacedJoin: joinMessage,
        replacedJoins,
        // 服务消息这一路带得到入群公告；不投 join 就没人再管它，交给处置一并删。
        announcementMessageId: message.message_id,
      })) {
        continue;
      }
      messages.push(joinMessage);
    }
    if (messages.length > 0) {
      await postAntiRaidDurably(messages, replacedJoins);
    }
    return true;
  }

  if (message.left_chat_member) {
    await postAntiRaidDurably([{
      type: "left",
      chatId: message.chat.id,
      userId: message.left_chat_member.id,
    }]);
    return false;
  }

  // 刷屏计数投递：与广告检测同一形态，主线程只做同步门禁 + 一次尽力而为的
  // post，窗口与禁言都在 Worker 侧（见 workers/antiRaid/floodControl.ts）。排在
  // 服务消息两条分支之后——入群/离群公告不是谁的「发言」，不该计进那个人的窗口。
  const floodCandidate: FloodCandidateMessage | undefined =
    buildFloodCandidate(message, botId);
  if (floodCandidate !== undefined) {
    // 顺手把这个群的权限位补齐一次（已知或已在途时是一次 Map 查找）：Worker 侧
    // 的禁言闸只认镜像过去的权限，而 my_chat_member 未必在本进程生命周期内到过。
    ensureBotChatPermissions(floodCandidate.chatId);
    // 投递被拒不记日志，与广告检测那条刻意不同：那一路只在 /ad_detect enable 的
    // 群上跑，而这一路每条群消息都走。post 返回 false 只有「Worker 正在重建」与
    // 「已放弃重建」两种成因，前者是亚秒级的、后者在 supervisor 那里已经带着
    // giveUpConsequence 响过一次；在这里逐条补一行 error，只会按群消息量把
    // logs/ 刷满，把真正的故障淹掉。丢掉的只是计数，窗口本来就随 isolate 生死。
    postAntiRaid(floodCandidate);
  }

  const userId: number | undefined = message.from?.id;
  // message_thread_id 有两个来源：关联频道讨论组的评论线程，和论坛（topics）
  // 群里的话题。只有前者可能是「评论早于 join 更新到达」的候选；论坛话题回复
  // 永远不可能是频道评论，把它排除掉，否则开了 topics 的群里每条普通消息都要
  // 白走一次 Worker barrier 与关联频道探测。
  const isCommentThreadReply: boolean =
    message.message_thread_id !== undefined &&
    message.is_topic_message !== true;
  const mayPrecedeJoinInCommentThread: boolean =
    message.reply_to_message?.is_automatic_forward === true ||
    isCommentThreadReply;
  if (
    userId !== undefined &&
    (
      activeVerificationSnapshots.has(
        verificationKey(message.chat.id, userId)
      ) ||
      mayPrecedeJoinInCommentThread
    )
  ) {
    // 附带频道评论区的识别线索：评论与楼中楼回复都代表 TA 已实际参与讨论，
    // Worker 据此免除验证且不计入刷群窗口。没有任何评论区消息的普通入群
    // 照常验证，超时仍会被踢出。
    await postAntiRaidDurably([{
      type: "message",
      chatId: message.chat.id,
      userId,
      messageId: message.message_id,
      repliesToChannelPost:
        message.reply_to_message?.is_automatic_forward === true,
      isThreadReply: isCommentThreadReply,
    }]);
  }
  return false;
}

/**
 * 处理入群验证按钮的点击（callback_query）：解析出目标成员后整体投递给
 * Worker 应答与处理。前缀不匹配的 callback_query 与本模块无关，直接放过。
 */
export async function handleVerificationCallback(
  ctx: Context
): Promise<void> {
  const query: CallbackQuery | undefined = ctx.callbackQuery;
  const data: string | undefined = query?.data;
  if (!query || !data?.startsWith(VERIFY_CALLBACK_PREFIX)) return;

  const targetUserId: number =
    Number(data.slice(VERIFY_CALLBACK_PREFIX.length));
  // callback_data 属于外部输入：前缀匹配不代表后半段一定是合法整数。NaN 若
  // 进入 Worker 会生成 "chatId:NaN" 状态键，按钮只会永远转圈且留下脏状态。
  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    await answerCallbackQuery({
      callbackQueryId: query.id,
      text: "验证请求无效",
      showAlert: true,
    });
    return;
  }

  await postAntiRaidDurably([{
    type: "callback",
    callbackQueryId: query.id,
    chatId: query.message?.chat.id,
    targetUserId,
    from: pickMember(query.from),
    fromIsWhitelisted: isWhitelisted(query.from.id),
  }]);
}
