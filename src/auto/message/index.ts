import type { Context } from "grammy";
import type { Message } from "@grammyjs/types";
import type { ChatState, CopyMode } from "../../types";
import { getActiveCopyIn, getActiveProxySendTarget, getChatState, getOrCreateChatState, saveState } from "../../infra/storage";
import { sendMessage, copyMessage } from "../../infra/telegram";
import { recordChatTitleFromChat } from "../../infra/chatTitle";
import { cacheSender } from "../../users/senderIdentity";
import { recordChatMessage, recordChatMedia, generateAndSendReply } from "../../aiChat";
import { AI_REPLY_PROBABILITY } from "../../consts/aiChat";
import {
  BATH_TRIGGER_MAX_MESSAGE_LENGTH,
  BATH_TRIGGER_PATTERN,
  BATH_TRIGGER_REPLY_TEXT,
  RANDOM_ECHO_MODES,
  RANDOM_ECHO_PROBABILITY,
  USER_REPLY_TRIGGER_COOLDOWN_MS,
} from "../../consts/auto";
import { userReplyTriggerTimes } from "../../cache/auto";
import { describeStickerForContext, pickStickerVisionSource } from "../../ai/stickerSets";
import { pickRandom } from "../../libs/random";
import { isSelfSent } from "../../infra/selfSentTracker";
import { SUPER_ADMIN_USER_ID } from "../../infra/config";
import { stripLuckReceipt } from "../../libs/luckReceipt";
import { echoMessage, resolveEffectiveCopyMode } from "./echo";
import {
  hasCopyableContent,
  isBotMentioned,
  isReplyToSelf,
  mentionsOtherUser,
  pickAnimationVisionSource,
  pickPhotoFile,
  resolveSpeaker,
} from "./facts";

/**
 * 消息自动流水线：复制目标的复读、AI 对话缓存与触发、洗澡「看看」、随机
 * 复读。与 src/commands 下的显式命令不同，这里的行为都是机器人自己看时机
 * 触发的。（入群守卫的事件投递不在这里——它以中间件形式挂在 index.ts 的
 * 命令处理器之前，否则命令消息会漏追踪；入群公告也在那里就被吞掉，到不了
 * 本流水线。）
 */

/**
 * 尝试为某个发言人占用一次「随机 AI 自动回复」名额。明确回复/@ 机器人的
 * 直接交互不经过这里，统一交给 Worker 的有界直接触发队列，不能被外层冷却
 * 静默丢弃。冷却按「群 × 用户」独立计算——key 里拼了 chatId，同一个人在 A 群
 * 触发过不影响 TA 在 B 群被回复。key 只用 id、不掺昵称：昵称随时可改，
 * 掺进去改个名就能重置冷却。记录会在冷却期满后自动从 Map 中清理（仅当
 * 期间没有更新的记录覆盖它），避免长期运行下的内存泄漏。
 */
function tryClaimUserReplyTrigger(chatId: number, speakerId: number): boolean {
  const key: string = `${chatId}_${speakerId}`;
  const now: number = Date.now();
  const lastTime: number = userReplyTriggerTimes.get(key) ?? 0;
  if (now - lastTime < USER_REPLY_TRIGGER_COOLDOWN_MS) return false;

  userReplyTriggerTimes.set(key, now);
  setTimeout(() => {
    if (userReplyTriggerTimes.get(key) === now) {
      userReplyTriggerTimes.delete(key);
    }
  }, USER_REPLY_TRIGGER_COOLDOWN_MS).unref();
  return true;
}

/**
 * 判断一条更新是不是机器人自己发出的消息原样回弹，命中就要整条跳过自动
 * 流水线（不记入 AI 对话缓存、不触发 AI 回复、不随机复读、不洗澡触发），
 * 否则会被自己的内容再触发一轮，自说自话。
 *
 * 内联结果消息（如 /luck_challenge 的 via_bot 消息）不走这里，是更早一步
 * 单独识别、单独处理的，见 handleIncomingMessage 顶部与 recordSelfInlineResult：
 * 那类消息虽然也是机器人生成的内容，但要自录入 AI 对话缓存（让模型知道
 * 自己刚说过这句话），只是不该触发主动行为，语义和这里的「纯回弹去重」
 * 不同，不能合并成一条 true/false。
 *
 * 普通群消息 Telegram 不会推回给发送者自己，但机器人在自己管理的频道发帖
 * 时，channel_post 更新不区分发帖者，会原样推回来；转发进关联讨论组的
 * 自动转发副本同理（forward_origin 指回原帖，is_automatic_forward 标记这是
 * 频道→讨论组的自动转发而非用户手动转发）。这两种回弹都靠
 * infra/selfSentTracker.ts 的登记表识别——机器人发送时（无论主线程还是哪个
 * Worker）都会把 chatId/messageId 登记进去，见 infra/telegram/ 的
 * sendMessage/copyMessage/sendSticker 与 aiChat.ts 对 Worker "sent" 事件的
 * 转登记。
 */
function isBotOwnMessage(message: Message): boolean {
  if (isSelfSent(message.chat.id, message.message_id)) return true;
  const origin = message.forward_origin;
  if (message.is_automatic_forward === true && origin?.type === "channel" && isSelfSent(origin.chat.id, origin.message_id)) return true;
  return false;
}

/**
 * 内联结果消息（如 /luck_challenge 抽到的运势/概率文本）的自录：用 botId/
 * botFirstName 当发言人、lastName 留空，与「看看」/随机复读的自录手法一致
 * （见 handleIncomingMessage 底部两处 recordChatMessage 调用），让 AI 认得出
 * 这是自己刚说过的话，被问起时能接上，而不是凭空冒出一句不知道是谁说的
 * 运势结果。gate 条件对齐其它记录点：私聊、复制目标进行中、本群未开 AI
 * 闲聊都不录；调用方拿到后无论是否录成都会直接 return，不触发下面任何
 * 主动行为（不复读、不触发 AI 回复、不洗澡）——这部分行为本就靠
 * isBotOwnMessage 之前的提前返回保证，这里只负责「要不要留个记忆」。
 */
function recordSelfInlineResult(message: Message, botId: number, botFirstName: string, botUsername: string): void {
  if (message.chat.type === "private") return;
  if (typeof message.text !== "string") return;
  const chatId: number = message.chat.id;
  if (getActiveCopyIn(chatId)) return;
  if (getChatState(chatId).isUseAIChat !== true) return;
  recordChatMessage(chatId, botId, botFirstName, "", botUsername, stripLuckReceipt(message.text));
}

/**
 * 处理每一条收到的 message/channel_post：刷新发送者缓存。如果消息来自当前
 * 正在被复制的目标、且发生在发起 /copy 的那个群里，则将其复读回同一个聊天；
 * 如果本群当前没有复读进行中，则以 RANDOM_ECHO_PROBABILITY 的概率随机挑一种
 * 模式复读这条消息（东一榔头西一棒子地刷存在感）。
 *
 * 最前面依次过两道门，命中任一道都不再往下走：
 * - via_bot 指向自己：内联结果消息（如 /luck_challenge），自录入 AI 对话
 *   缓存后直接返回，见 recordSelfInlineResult。（运势抽签的确认落盘不在
 *   这里做——签名回执认领挂在 index.ts 的 isInit 网关之前，不然转发进未 /init
 *   群的结果副本根本到不了本函数，见 commands/luckChallenge.ts 的
 *   confirmLuckDraw。）
 * - isBotOwnMessage：机器人自己发出消息的原样回弹（频道自回环），整条跳过、
 *   连记忆都不留。
 */
export async function handleIncomingMessage(ctx: Context): Promise<void> {
  const message: Message | undefined = ctx.msg;
  if (!message) return;
  // 顺手用这条更新自带的 chat.title 刷新群名称记录（零额外 API 开销，见
  // infra/chatTitle.ts）；与下面自弹回环/复读等判断无关，任何一条更新都能
  // 提供最新群名，不必等它们判定完。
  recordChatTitleFromChat(message.chat);
  if (message.via_bot?.id === ctx.me.id) {
    recordSelfInlineResult(message, ctx.me.id, ctx.me.first_name, ctx.me.username);
    return;
  }
  if (isBotOwnMessage(message)) return;

  const chatId: number = message.chat.id;
  const senderId: number | undefined = cacheSender(message);
  const state: ChatState = getChatState(chatId);

  // 复读目标全局唯一，但复读只发生在发起 /copy 的那个群里（判定统一走
  // getActiveCopyIn）——同一个目标在别的群发言不复读，别的群的 AI 闲聊/
  // 随机复读也不因此被抑制。
  const activeCopy = getActiveCopyIn(chatId);

  // 检查是否需要复读当前目标（用户或频道皮套）的消息
  if (activeCopy && senderId === activeCopy.copiedUser.id) {
    await echoMessage(chatId, message, resolveEffectiveCopyMode(chatId, activeCopy.copyMode), activeCopy.copiedUser.id);
    return;
  }

  // 私聊只消费超管的活动中转会话；其余私聊不进入任何群聊自动行为。
  if (message.chat.type === "private") {
    // 身份校验必须先于查找目标，防止外部私聊泄露或内容注入。
    if (message.from?.id !== SUPER_ADMIN_USER_ID) return;
    const targetChatId: number | undefined = getActiveProxySendTarget();
    if (targetChatId !== undefined) {
      const copiedMessageId: number | undefined = await copyMessage(targetChatId, chatId, message.message_id);
      if (copiedMessageId === undefined) {
        // 失败后立即结束会话，避免后续消息被静默吞掉。
        getOrCreateChatState(targetChatId).isUseProxySend = false;
        await saveState();
        await sendMessage(chatId, `转发到 ${targetChatId} 失败了，本天才先把这轮中转停掉了，检查一下再 /send 重新开吧♡`);
      }
    }
    return;
  }

  // /quiet 静默期内暂停一切主动刷存在感的行为（AI 随机插话、洗澡「看看」、
  // 随机复读），只保留被动触发（回复机器人 / @ 机器人）和指令。
  const isQuiet: boolean = (state.quietUntil ?? 0) > Date.now();

  // 本群的 AI 闲聊开关（state.json 里按群配置 isUseAIChat，见 ChatState）：
  // 缺省关闭，需群管理员通过 /ai_chat enable 显式开启。关闭的群连对话缓存都
  // 不攒（攒了也没有会消费它的回复流水线），回复/@ 机器人也不再回。
  const aiChatEnabled: boolean = state.isUseAIChat === true;

  const messageText: string | undefined = typeof message.text === "string" ? message.text : undefined;
  // 「用户回复机器人」的判定给文本与媒体分支共用：拿贴纸/图片/GIF 回复
  // 机器人同样是明确在跟机器人说话，不能因为消息没有 text 就识别不到。
  const repliedTo: Message | undefined = message.reply_to_message;
  const isReplyToBot: boolean = !!repliedTo && repliedTo.from?.id === ctx.me.id;
  const isMentioned: boolean = isBotMentioned(message, ctx.me.username);
  const hasOtherMention: boolean = mentionsOtherUser(message, ctx.me.id, ctx.me.username);
  const repliesToSelf: boolean = isReplyToSelf(message);
  const directMediaTrigger: { reason: "reply" | "mention"; repliedBotText?: string } | undefined = isReplyToBot
    ? { reason: "reply", repliedBotText: repliedTo?.text }
    : isMentioned
    ? { reason: "mention" }
    : undefined;
  if (!activeCopy && aiChatEnabled && messageText && !messageText.startsWith("/")) {
    // 把带文本的普通消息滚动记入本群的 AI 对话缓存（Bot API 无法拉历史，只能
    // 边收边攒，上限见 consts/aiChat.ts 的 VERBATIM_CONTEXT_MAX）。指令消息
    // （/ 开头）已在上面排除。
    const speaker = resolveSpeaker(message);
    recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, speaker.username, messageText);

    // AI 闲聊回复：用户回复机器人、或者消息里 @ 了机器人 → 必然触发；否则
    // 普通发言按 AI_REPLY_PROBABILITY 概率触发。「插不插话」的闸门就是这里
    // 的掷骰——命中后怎么回由模型在 Worker 侧自主决定，但必须回应（说话/
    // 贴纸/扣反应都算）、不允许沉默（见 workers/aiChatWorker.ts 的
    // generateAndSendReply）。命中后就不再走下面的洗澡/随机复读，免得一条
    // 消息既被 AI 回又被复读。
    // 消息里 @ 了别人（非机器人自己）、或发送者是在回复自己时，不参与
    // 随机搭话的概率判定——这类消息已有明确交流对象或是在补充自己的话；
    // 不影响上面 isReplyToBot/isMentioned 两条明确指向机器人的必回路径。
    const isRandomTrigger: boolean =
      !isReplyToBot && !isMentioned && !isQuiet &&
      !hasOtherMention && !repliesToSelf &&
      Math.random() < AI_REPLY_PROBABILITY;

    if (isReplyToBot || isMentioned) {
      generateAndSendReply(chatId, message.message_id, isReplyToBot ? repliedTo?.text : undefined);
      return;
    }
    if (isRandomTrigger) {
      if (tryClaimUserReplyTrigger(chatId, speaker.id)) {
        generateAndSendReply(chatId, message.message_id, undefined, true);
      }
      return;
    }
  } else if (!activeCopy && aiChatEnabled && message.sticker) {
    // 贴纸消息没有文本：先备好现有的元数据兜底行（情绪 emoji、所属贴纸包，
    // 见 ai/stickerSets.ts 的 describeStickerForContext），再看有没有可用的
    // 视觉解析素材（静态贴纸下载本体；动态/视频贴纸没有可解码的本体，改用
    // 缩略图；两者都没有则放弃视觉，见 pickStickerVisionSource）。没有素材
    // 就直接记兜底行；有素材则交给 AI Worker 走占位/异步解析管线（见
    // aiChat.ts 的 recordChatMedia），解析成功原位回填画面描述，失败回填
    // 同一份兜底行，都不损失现状已有信息。基线只当上下文、不触发 AI 回复，
    // 也不 return——后面的随机复读本来就对贴纸生效，行为保持不变。两个
    // 例外：拿贴纸明确跟机器人说话（回复机器人，或 caption 里 @ 机器人）时
    // 必触发回复（directMediaTrigger，Worker 侧先试常驻目录/描述缓存，未命中
    // 等解析完成再回答）；随机评价见下方 commentOnResolve。
    const speaker = resolveSpeaker(message);
    const fallbackText: string = describeStickerForContext(message.sticker);
    const visionSource = pickStickerVisionSource(message.sticker);
    if (!visionSource) {
      recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, speaker.username, fallbackText);
      // 没有视觉素材也要认得「明确在跟机器人说话」：兜底行刚记到缓存尾部，
      // 元数据（emoji/包名）就是全部可用信息，直接触发回复；明确交互不受
      // 随机搭话冷却影响，由 Worker 的有界直接触发队列承接。
      if (directMediaTrigger) {
        generateAndSendReply(chatId, message.message_id, directMediaTrigger.repliedBotText);
        return;
      }
    } else {
      // 例外：按 AI_REPLY_PROBABILITY 掷中时，解析完成后 AI 会回复那条贴纸
      // 消息评价它——文字随机搭话与图片/贴纸/GIF 评价共用同一个概率（不是
      // 各自独立掷骰），掷骰在这里（主线程调度逻辑），顺带套用 /quiet 静默。
      // 回复机器人时不掷骰（必回，与文字路径一致地无视 /quiet），两者互斥
      // （commentOnResolveCandidate 要求 !directMediaTrigger）。必回触发与
      // 随机评价因此至多命中其一；只有随机评价占用 15s 每人冷却名额，
      // 媒体本身无论是否取得随机名额都照常入缓存当上下文。
      const commentOnResolveCandidate: boolean =
        !directMediaTrigger && !isQuiet && !hasOtherMention && !repliesToSelf &&
        Math.random() < AI_REPLY_PROBABILITY;
      const claimedRandomTrigger: boolean = commentOnResolveCandidate && tryClaimUserReplyTrigger(chatId, speaker.id);
      recordChatMedia(
        "sticker",
        chatId,
        speaker.id,
        speaker.firstName,
        speaker.lastName,
        speaker.username,
        "",
        visionSource.fileId,
        visionSource.fileUniqueId,
        message.message_id,
        claimedRandomTrigger,
        fallbackText,
        directMediaTrigger
      );
      // 与文字路径的必回触发同语义：这条贴纸已经交给 AI 直接回复或随机
      // 评价判定，不再参与下面的随机复读，免得一条消息
      // 既被回又被复读。
      if (directMediaTrigger || commentOnResolveCandidate) return;
    }
  } else if (!activeCopy && aiChatEnabled && Array.isArray(message.photo) && message.photo.length > 0) {
    // 图片消息同样没有 text（配文在 caption 里），交给 AI Worker 先占位入
    // 缓存、异步解析出描述后原位回填（见 aiChat.ts 的 recordChatMedia）。
    // 基线与贴纸/GIF 同定位：只当上下文，不触发 AI 回复，也不 return——
    // 后面的随机复读对图片本来就生效，行为保持不变。拿图片回复机器人则
    // 必触发（directMediaTrigger，同贴纸分支）。相册（一次发多张）是
    // 多条相邻消息各带一张图，自然逐条走到这里，各自占位、各自解析。
    const speaker = resolveSpeaker(message);
    const caption: string = typeof message.caption === "string" ? message.caption : "";
    // 必回触发与随机评价互斥；只有随机评价使用 15s 每人冷却，理由同贴纸分支。
    const commentOnResolveCandidate: boolean =
      !directMediaTrigger && !isQuiet && !hasOtherMention && !repliesToSelf &&
      Math.random() < AI_REPLY_PROBABILITY;
    const claimedRandomTrigger: boolean = commentOnResolveCandidate && tryClaimUserReplyTrigger(chatId, speaker.id);
    const photoFile = pickPhotoFile(message.photo);
    recordChatMedia(
      "photo",
      chatId,
      speaker.id,
      speaker.firstName,
      speaker.lastName,
      speaker.username,
      caption,
      photoFile.fileId,
      photoFile.fileUniqueId,
      message.message_id,
      claimedRandomTrigger,
      undefined,
      directMediaTrigger
    );
    if (directMediaTrigger || commentOnResolveCandidate) return;
  } else if (!activeCopy && aiChatEnabled && message.animation) {
    // GIF（Telegram animation，实际多为 mp4）：本项目没有视频解码/抽帧能力，
    // 只能分析 Telegram 自带的缩略图（封面帧，见 pickAnimationVisionSource）。
    // 有缩略图就走占位/异步解析管线（同图片/贴纸）；没有缩略图（罕见）就
    // 只记一条占位纯文本，不触发解析、也不参与评价掷骰。
    const speaker = resolveSpeaker(message);
    const caption: string = typeof message.caption === "string" ? message.caption : "";
    const visionSource = pickAnimationVisionSource(message.animation);
    if (!visionSource) {
      recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, speaker.username, caption ? `[GIF] ${caption}` : "[GIF]");
      // 同贴纸分支：没有解析素材也要认得「明确在跟机器人说话」，直接交给
      // Worker 的有界直接触发队列。
      if (directMediaTrigger) {
        generateAndSendReply(chatId, message.message_id, directMediaTrigger.repliedBotText);
        return;
      }
    } else {
      // 必回触发与随机评价互斥；只有随机评价使用 15s 每人冷却。
      const commentOnResolveCandidate: boolean =
        !directMediaTrigger && !isQuiet && !hasOtherMention && !repliesToSelf &&
        Math.random() < AI_REPLY_PROBABILITY;
      const claimedRandomTrigger: boolean = commentOnResolveCandidate && tryClaimUserReplyTrigger(chatId, speaker.id);
      recordChatMedia(
        "animation",
        chatId,
        speaker.id,
        speaker.firstName,
        speaker.lastName,
        speaker.username,
        caption,
        visionSource.fileId,
        visionSource.fileUniqueId,
        message.message_id,
        claimedRandomTrigger,
        undefined,
        directMediaTrigger
      );
      if (directMediaTrigger || commentOnResolveCandidate) return;
    }
  }

  // 没有复读对象时，说到洗澡/泡澡/冲凉就回一句「看看」（触发词规则见
  // consts/auto.ts 的 BATH_TRIGGER_PATTERN 注释）。以 / 开头的是指令（未注册的、
  // 或发给其他机器人的指令不会被 bot.command 拦截，会落到这里），与
  // echoMessage 的「不复读指令消息」保持一致，不触发。私聊不触发——与 AI
  // 随机插话同理，这些刷存在感的行为都是群聊语境的。
  if (!activeCopy && !isQuiet && typeof message.text === "string" && !message.text.startsWith("/") && message.text.length <= BATH_TRIGGER_MAX_MESSAGE_LENGTH && BATH_TRIGGER_PATTERN.test(message.text)) {
    const sentMessageId: number | undefined = await sendMessage(chatId, BATH_TRIGGER_REPLY_TEXT, message.message_id);
    // 自录进 AI 对话缓存，让模型知道自己刚说过这句——不然它凭空多出一句
    // 不知道是谁说的「看看」，后续被问起时接不上。isBotOwnMessage 那道门
    // 只挡自己消息的回弹（频道自回环）重新触发，记忆本身还是要留的
    // （短期进滚动缓存，随批次轮换自然被压缩进中期摘要，见
    // aiChatWorker.ts 的 recordChatMessage/scheduleRotation）。
    if (aiChatEnabled && sentMessageId !== undefined) {
      recordChatMessage(chatId, ctx.me.id, ctx.me.first_name, "", ctx.me.username, BATH_TRIGGER_REPLY_TEXT);
    }
    return;
  }

  // 没有复读对象时的随机复读（私聊不触发，同上）。无需担心和其他机器人形成
  // 复读循环：Telegram 保证机器人收不到其他机器人发的消息（官方为防止 bot
  // 互相触发死循环的设计）；普通群消息里自己发的也不会作为更新推送回来，
  // 频道场景的例外由 isBotOwnMessage 挡住（见其注释）。
  if (!activeCopy && !isQuiet && hasCopyableContent(message) && Math.random() < RANDOM_ECHO_PROBABILITY) {
    const mode: CopyMode | undefined = resolveEffectiveCopyMode(chatId, pickRandom(RANDOM_ECHO_MODES));
    const echoedText: string | undefined = await echoMessage(chatId, message, mode);
    // 同上，自录复读出去的文本（纯媒体复读没有文本可录，保持沉默）。
    if (aiChatEnabled && echoedText !== undefined) {
      recordChatMessage(chatId, ctx.me.id, ctx.me.first_name, "", ctx.me.username, echoedText);
    }
  }
}
