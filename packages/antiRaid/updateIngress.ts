import type { Context } from "grammy";
import type {
  CallbackQuery,
  ChatMemberUpdated,
  Message,
  User,
} from "@grammyjs/types";
import { logger } from "../infra/logger";
import { recordJoinLog } from "../infra/joinLog";
import { answerCallbackQuery } from "../infra/telegram/actions";
import {
  ensureBotChatPermissions,
  resolveBotAdminStatus,
  markBotAdminObserved,
} from "../infra/botAdmin";
import { VERIFY_CALLBACK_PREFIX } from "../consts/antiRaid/verification";
import { isAdminStatus } from "../libs/chatMember";
import { verificationKey } from "../libs/verificationKey";
import { activeVerificationSnapshots } from "../cache/main/antiRaid/verificationMirror";
import { isWhitelisted } from "../infra/identityPolicy/whitelist";
import { getChatState } from "../infra/storage/stateStore";
import { buildAdCandidate } from "./adCandidate";
import { observeChatKind } from "./chatKind";
import {
  claimBlockedJoiner,
  deleteBlockedSenderChatMessage,
} from "./blocklistGuard";
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
} from "../types/antiRaid/adDetect";
import type {
  AntiRaidWorkerMessage,
  FloodCandidateMessage,
} from "../types/antiRaid/protocol";

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
  // 群类型镜像：只有主线程看得见 chat.type，而踢人在 Worker 里按它分派方法
  // （见 ./chatKind.ts）。按值去重，正常情况下每个群一生只投一两条。
  observeChatKind(update.chat);
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

  // 入群守卫的总开关（`/antiraid`）。关着的群仍然记入群日志、仍然按黑名单秒踢
  // ——那两件事各自独立（`/batch_kick` 的依据、永久名单），只有验证窗口与私密
  // 模式这条链路跟着它一起停（见 types/chatState.ts 的 isAntiRaidEnabled）。
  const joinGuardEnabled: boolean = getChatState(chatId).isAntiRaidEnabled === true;

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
  // 这一条**不受开关门控**：它是低频的缓存维护消息，applyAdminChange 只改邀请者
  // 豁免缓存、不碰状态机，守卫关着时投过去没有任何副作用。反过来漏掉它是有代价的
  // ——缓存条目按 fetchedAt 判过期而 applyAdminChange 不刷新它（见
  // workers/antiRaid/adminCache.ts），若「关闭 → 某人被降权 → 重新开启」挤在同一个
  // ADMIN_CACHE_TTL_MS 窗口里，剩余那段时间他拉进来的人仍会免验证。
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
    // 使用 Telegram 事件自带时间戳作为幂等 key 的一部分；落盘 Worker 在写前
    // 按用户最新记录去重。同一 update 只有 joinLog 领域 durable 后才继续投递，
    // 否则让 update 失败重投，不能静默漏掉慢速僵尸清理依据。
    const joinLogged: boolean = await recordJoinLog({
      chatId,
      userId: user.id,
      joinedAt: update.date * 1000,
    });
    if (!joinLogged) {
      throw new Error(
        `Persistence Worker rejected join log event for chat ${chatId}, user ${user.id}.`
      );
    }
    // 以管理员/群主身份入群的（典型如群主退群重进）免验证。身份只有本路径
    // 可见，new_chat_members 服务消息里没有——所以不能简单跳过不投递，而要
    // 带 exempt 标记投给 Worker：若服务消息那一路已抢先开了验证窗口，Worker
    // 收到豁免后会将其撤销。
    const joinMessage: AntiRaidWorkerMessage | undefined = joinGuardEnabled
      ? {
        type: "join",
        chatId,
        member: pickMember(user),
        exempt: isAdmin,
        actorId: update.from.id,
        actorIsWhitelisted: isWhitelisted(update.from.id),
      }
      : undefined;
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
 * 命令处理器之前
 * ——这样待验证用户发的命令消息（/copy 之类）也会计入刷屏窗口。职责：在群组
 * 未隐藏 `new_chat_members`/`left_chat_member` 服务消息时顺带捕获它们，并把
 * 每条消息的（chatId, userId, messageId）投递给 Worker；messageId 只用于回复式
 * 提醒和频道评论豁免锚点，不会在纯 kick 时用于删除成员发言。
 * 入群/离群本身的检测由 handleChatMemberUpdate 驱动——与这些服务消息
 * 不同，它总是会触发。
 * @returns 若消息在此已被完全处理、调用方应跳过后续处理逻辑（入群公告），
 * 返回 true；否则返回 false，让消息正常继续流转。
 */
export async function handleAntiRaidMessageIngress(
  message: Message,
  botId: number
): Promise<boolean> {
  // 验证只发生在群聊里，私聊消息不必跨线程投递去查一次注定落空的 Map。
  if (message.chat?.type === "private") return false;

  // 群类型镜像（见 ./chatKind.ts）。排在管理员门禁之前：机器人此刻不是管理员
  // 不代表以后不是，而这张表按值去重、每个群一生只投一两条，提前记没有代价。
  observeChatKind(message.chat);

  // 机器人不是本群管理员时整个入群守卫不启动：踢人/删消息都做不了，投递
  // 过去只会让 Worker 开一堆注定失败的验证窗口、刷一堆权限报错。已有身份
  // 记录时这个判定是同步的（不打 API），只有从未记录过的群会现查一次。
  // 入群公告照样吞掉（服务消息本来就不该流进复读/AI 流水线），只是不投递。
  if (!(await resolveBotAdminStatus(message.chat.id))) {
    return !!(
      message.new_chat_members &&
      message.new_chat_members.length > 0
    );
  }

  // 永久黑名单不依赖广告开关、模型密钥或样本配置。频道身份没有
  // banChatMember.revoke_messages 可用，因此每条仍漏进来的消息必须在公共入口
  // 就地删除；真人用户则由在途 banChatMember 的服务端全量撤回收口。
  if (await deleteBlockedSenderChatMessage(message)) return true;

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
    // 入群守卫关着时这一路只剩黑名单秒踢：不开验证窗口、不记入群计数，但公告
    // 照样吞掉（服务消息本来就不该进复读/AI 流水线，与守卫开关无关）。
    const joinGuardEnabled: boolean =
      getChatState(message.chat.id).isAntiRaidEnabled === true;
    const messages: AntiRaidWorkerMessage[] = [];
    const replacedJoins: Map<number, AntiRaidWorkerMessage> = new Map();
    for (const member of message.new_chat_members) {
      // 机器人不再豁免（走白名单用户代点验证的流程），只跳过本天才自己
      // ——自己既不能验证自己，也不该被自己踢出去。
      if (member.id === botId) continue;
      const joinMessage: AntiRaidWorkerMessage | undefined = joinGuardEnabled
        ? {
          type: "join",
          chatId: message.chat.id,
          member: pickMember(member),
          announcementMessageId: message.message_id,
          actorId: message.from?.id,
          actorIsWhitelisted:
            message.from !== undefined &&
            isWhitelisted(message.from.id),
        }
        : undefined;
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
        joinGuardEnabled,
      })) {
        continue;
      }
      if (joinMessage !== undefined) messages.push(joinMessage);
    }
    if (messages.length > 0) {
      await postAntiRaidDurably(messages, replacedJoins);
    }
    return true;
  }

  if (message.left_chat_member) {
    // left 只用来撤销这个人的验证窗口；守卫关着时没有窗口可撤。
    if (getChatState(message.chat.id).isAntiRaidEnabled === true) {
      await postAntiRaidDurably([{
        type: "left",
        chatId: message.chat.id,
        userId: message.left_chat_member.id,
      }]);
    }
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
      // 先看表空不空再拼键：待验证镜像绝大多数时候是空的（没人正在验证），
      // 而 `${chatId}:${userId}` 是每条群消息都要现造的一个短命字符串。
      // `has()` 在空表上恒为 false，这道前置判断不改变任何结果。
      (
        activeVerificationSnapshots.size > 0 &&
        activeVerificationSnapshots.has(
          verificationKey(message.chat.id, userId)
        )
      ) ||
      mayPrecedeJoinInCommentThread
    ) &&
    // 排在最后：守卫开着的群才需要这条投递，而上面两个判定比一次 Map 取值更
    // 便宜（空表恒 false）。关着的群没有窗口，评论区线索也无处可用。
    getChatState(message.chat.id).isAntiRaidEnabled === true
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

  // 守卫已关的群里还可能留着一颗没被删掉的旧按钮（disable 那次 Worker 不可用
  // 就会这样）。当场应答掉、不投给 Worker：不应答的话点的人只看到按钮一直转，
  // 而投过去只会为一个已经关掉的功能重新开工。
  const callbackChatId: number | undefined = query.message?.chat.id;
  if (
    callbackChatId !== undefined &&
    getChatState(callbackChatId).isAntiRaidEnabled !== true
  ) {
    await answerCallbackQuery({
      callbackQueryId: query.id,
      text: "本天才已经不守这个群的门啦♡",
      showAlert: true,
    });
    return;
  }

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
