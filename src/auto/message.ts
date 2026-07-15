import type { Context } from "grammy";
import type { CachedUser, ChatState, CopyMode } from "../types";
import { getActiveCopyIn, getChatState } from "../infra/storage";
import { sendMessage, copyMessage } from "../infra/telegram";
import { applyCopyModeTransform } from "../copy/copyModes";
import { cacheSender } from "../users/senderIdentity";
import { recordChatMessage, generateAndSendReply } from "../aiChat";
import { confirmLuckDraw } from "../commands";
import { AI_REPLY_PROBABILITY } from "../consts/aiChat";
import {
  BATH_TRIGGER_MAX_MESSAGE_LENGTH,
  BATH_TRIGGER_PATTERN,
  RANDOM_ECHO_MODES,
  RANDOM_ECHO_PROBABILITY,
  USER_RANDOM_REPLY_COOLDOWN_MS,
} from "../consts/auto";
import { userRandomReplyTimes } from "../cache/auto";
import { describeStickerForContext } from "../ai/stickerSets";
import { pickRandom } from "../libs/random";
import { isSelfSent } from "../infra/selfSentTracker";

/**
 * 消息自动流水线：复制目标的复读、AI 对话缓存与触发、洗澡「看看」、随机
 * 复读。与 src/commands 下的显式命令不同，这里的行为都是机器人自己看时机
 * 触发的。（入群守卫的事件投递不在这里——它以中间件形式挂在 index.ts 的
 * 命令处理器之前，否则命令消息会漏追踪；入群公告也在那里就被吞掉，到不了
 * 本流水线。）
 */

/**
 * 尝试为某个发言人占用一次「AI 随机回复」的名额：若 TA 仍在冷却期内则返回
 * false；否则记录本次触发时刻并返回 true。冷却按「群 × 用户」独立计算——
 * key 里拼了 chatId，同一个人在 A 群触发过不影响 TA 在 B 群被随机回复。
 * key 只用 id、不掺昵称：昵称随时可改，掺进去改个名就能重置冷却。
 * 记录会在冷却期满后自动从 Map 中清理（仅当期间没有更新的记录覆盖它），
 * 避免长期运行下的内存泄漏。
 */
function tryClaimUserRandomReply(chatId: number, speakerId: number): boolean {
  const key: string = `${chatId}_${speakerId}`;
  const now: number = Date.now();
  const lastTime: number = userRandomReplyTimes.get(key) ?? 0;
  if (now - lastTime < USER_RANDOM_REPLY_COOLDOWN_MS) return false;

  userRandomReplyTimes.set(key, now);
  setTimeout(() => {
    if (userRandomReplyTimes.get(key) === now) {
      userRandomReplyTimes.delete(key);
    }
  }, USER_RANDOM_REPLY_COOLDOWN_MS).unref();
  return true;
}

/**
 * 解析一条消息发言人喂给 AI 上下文所需的身份三元组：id + first_name + last_name。
 * 刻意把 id 和名字分开存（而非拼成一个昵称字符串），好让模型按 id 区分同名的人。
 * 频道马甲/频道帖没有 first_name/last_name，退化为用 title 当 firstName。
 */
function resolveSpeaker(message: any): { id: number; firstName: string; lastName: string } {
  const fromUser: any = message.from;
  const senderChat: any = message.sender_chat || (message.chat.type === "channel" ? message.chat : undefined);
  if (senderChat) {
    return { id: senderChat.id, firstName: senderChat.title ?? "某频道", lastName: "" };
  }
  if (fromUser) {
    return { id: fromUser.id, firstName: fromUser.first_name ?? "", lastName: fromUser.last_name ?? "" };
  }
  return { id: 0, firstName: "某杂鱼", lastName: "" };
}

/**
 * 判断一条消息的文本里是否 @ 了机器人自己。走 entities 里的 "mention" 类型
 * （@username 形式），按 offset/length 截出实际文本再跟机器人的 username 比对，
 * 不用简单的字符串 includes——避免把「@somebody_else_bot」这种子串误判成命中。
 */
function isBotMentioned(message: any, botUsername: string | undefined): boolean {
  if (!botUsername || typeof message.text !== "string") return false;
  const entities: any[] | undefined = message.entities;
  if (!entities) return false;
  const target: string = `@${botUsername}`.toLowerCase();
  for (const entity of entities) {
    if (entity.type === "mention") {
      const mentionText: string = message.text.substring(entity.offset, entity.offset + entity.length);
      if (mentionText.toLowerCase() === target) return true;
    }
  }
  return false;
}

/**
 * 判断一条消息的文本里是否 @ 了机器人自己以外的某个用户。逻辑与 isBotMentioned
 * 对称（同样只认 entities 里的 "mention" 类型），排除掉的那一个就是机器人自己：
 * 消息里 @ 别人，大概率是在跟那个人说话，不是在给机器人递话头，随机搭话
 * 贸然插进去会很突兀，所以只用来抑制 isRandomTrigger（见下方调用点），不影响
 * 「回复机器人」「@ 机器人」这两条本就明确指向机器人的必回路径——这两种
 * 情况即便消息里同时 @ 了别人，机器人被叫到也该照常回。
 */
function mentionsOtherUser(message: any, botUsername: string | undefined): boolean {
  if (typeof message.text !== "string") return false;
  const entities: any[] | undefined = message.entities;
  if (!entities) return false;
  const botTarget: string | undefined = botUsername ? `@${botUsername}`.toLowerCase() : undefined;
  for (const entity of entities) {
    if (entity.type === "mention") {
      const mentionText: string = message.text.substring(entity.offset, entity.offset + entity.length).toLowerCase();
      if (mentionText !== botTarget) return true;
    }
  }
  return false;
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
 * Worker）都会把 chatId/messageId 登记进去，见 infra/telegram.ts 的
 * sendMessage/copyMessage/sendSticker 与 aiChat.ts 对 Worker "sent" 事件的
 * 转登记。
 */
function isBotOwnMessage(message: any, botId: number): boolean {
  if (isSelfSent(message.chat.id, message.message_id)) return true;
  const origin: any = message.forward_origin;
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
function recordSelfInlineResult(message: any, botId: number, botFirstName: string): void {
  if (message.chat.type === "private") return;
  if (typeof message.text !== "string") return;
  const chatId: number = message.chat.id;
  if (getActiveCopyIn(chatId)) return;
  if (getChatState(chatId).isUseAIChat !== true) return;
  recordChatMessage(chatId, botId, botFirstName, "", message.text);
}

/**
 * 将一条消息复读回它所在的聊天，并按给定模式做文本变换。
 * @param mode 要应用的文本变换（undefined 表示原样复读）。
 * @returns 实际发出去的文本（变换后的文本，或原样复读时的原文），供调用方
 *   决定要不要自录进 AI 对话缓存（见两处调用点：/copy 锁定目标期间故意不录，
 *   随机复读会录）；纯媒体消息（没有 text）或发送失败则返回 undefined。
 */
async function echoMessage(chatId: number, message: any, mode: CopyMode | undefined): Promise<string | undefined> {
  const text: string = message.text || "";
  // 不复读指令消息，防止指令无限解析
  if (text.startsWith("/")) return undefined;

  // 安全校验：只对"纯文本"消息本身做变换（有 text、无 entities、非媒体）；
  // 带格式/链接/@提及的消息一旦被反转或拼接后缀，会破坏 entity 的偏移量，
  // 可能被用来伪造看似正常、实际指向别处的链接/提及，所以这类消息以及
  // 非文本消息一律走原样 copyMessage，不做任何文本变换。
  const isPlainText: boolean =
    typeof message.text === "string" &&
    (!message.entities || message.entities.length === 0);

  const transformed: string | null = isPlainText
    ? await applyCopyModeTransform(message.text, mode)
    : null;

  if (transformed !== null) {
    // 变换后的文本只当作纯文本发送（sendMessage 不带 parse_mode），不会被
    // Telegram 当作 HTML/Markdown 解析，也就不存在把用户输入拼进富文本
    // 导致的格式/链接注入问题。
    const sentMessageId: number | undefined = await sendMessage(chatId, transformed);
    return sentMessageId !== undefined ? transformed : undefined;
  }

  // 无变换模式、非纯文本消息、或变换本身失败（如翻译出错）都退化为原样转发。
  const copiedMessageId: number | undefined = await copyMessage(chatId, chatId, message.message_id);
  return copiedMessageId !== undefined && typeof message.text === "string" ? message.text : undefined;
}

/**
 * 判断一条消息是否有可以被 copyMessage 复制的实际内容。随机复读要靠它过滤掉
 * 置顶提示、成员变动之类的服务消息——对这类消息调用 copyMessage 必然报错。
 * （被 /copy 锁定的目标不走这个过滤：TA 的消息本就该尽数复读，个别复制失败
 * 记日志即可。）
 */
function hasCopyableContent(message: any): boolean {
  return !!(
    message.text || message.caption || message.photo || message.sticker ||
    message.animation || message.video || message.video_note || message.audio ||
    message.voice || message.document || message.dice || message.contact ||
    message.location || message.venue || message.poll || message.story
  );
}

/**
 * 处理每一条收到的 message/channel_post：刷新发送者缓存。如果消息来自当前
 * 正在被复制的目标、且发生在发起 /copy 的那个群里，则将其复读回同一个聊天；
 * 如果本群当前没有复读进行中，则以 RANDOM_ECHO_PROBABILITY 的概率随机挑一种
 * 模式复读这条消息（东一榔头西一棒子地刷存在感）。
 *
 * 最前面依次过两道门，命中任一道都不再往下走：
 * - via_bot 指向自己：内联结果消息（如 /luck_challenge），自录入 AI 对话
 *   缓存后直接返回，见 recordSelfInlineResult；同时这也是运势抽签唯一的
 *   「真的发出去了」信号，顺带调用 confirmLuckDraw 把对应的抽签结果从
 *   pending 转正、落盘，见 commands/luckChallenge.ts 的注释——用户只是打字
 *   预览、没选中任何结果就不会走到这里，不会被当成测过运势。
 * - isBotOwnMessage：机器人自己发出消息的原样回弹（频道自回环），整条跳过、
 *   连记忆都不留。
 */
export async function handleIncomingMessage(
  ctx: Context,
  users: Record<string, CachedUser>
): Promise<void> {
  const message: any = ctx.msg;
  if (!message) return;
  if (message.via_bot?.id === ctx.me.id) {
    recordSelfInlineResult(message, ctx.me.id, ctx.me.first_name);
    confirmLuckDraw(message.from?.id, message.text);
    return;
  }
  if (isBotOwnMessage(message, ctx.me.id)) return;

  const chatId: number = message.chat.id;
  const senderId: number | undefined = cacheSender(message, users);
  const state: ChatState = getChatState(chatId);

  // 复读目标全局唯一，但复读只发生在发起 /copy 的那个群里（判定统一走
  // getActiveCopyIn）——同一个目标在别的群发言不复读，别的群的 AI 闲聊/
  // 随机复读也不因此被抑制。
  const activeCopy = getActiveCopyIn(chatId);

  // 检查是否需要复读当前目标（用户或频道皮套）的消息
  if (activeCopy && senderId === activeCopy.copiedUser.id) {
    await echoMessage(chatId, message, activeCopy.copyMode);
    return;
  }

  // /quiet 静默期内暂停一切主动刷存在感的行为（AI 随机插话、洗澡「看看」、
  // 随机复读），只保留被动触发（回复机器人 / @ 机器人）和指令。
  const isQuiet: boolean = (state.quietUntil ?? 0) > Date.now();

  // 本群的 AI 闲聊开关（state.json 里按群配置 isUseAIChat，见 ChatState）：
  // 缺省关闭，需群管理员通过 /ai_chat enable 显式开启。关闭的群连对话缓存都
  // 不攒（攒了也没有会消费它的回复流水线），回复/@ 机器人也不再回。
  const aiChatEnabled: boolean = state.isUseAIChat === true;

  // AI 相关逻辑仅在「群聊」且「没有复制对象」时进行：私聊消息不触发（机器人在
  // 私聊里没有群聊上下文，也不该在 DM 里自动搭话）；复制期间机器人正忙着复读
  // 目标，既不攒对话缓存也不触发 AI 回复，免得跟复读抢戏。
  const isPrivateChat: boolean = message.chat.type === "private";
  const messageText: string | undefined = typeof message.text === "string" ? message.text : undefined;
  if (!isPrivateChat && !activeCopy && aiChatEnabled && messageText && !messageText.startsWith("/")) {
    // 把带文本的普通消息滚动记入本群的 AI 对话缓存（Bot API 无法拉历史，只能
    // 边收边攒最近 75 条）。指令消息（/ 开头）已在上面排除。
    const speaker = resolveSpeaker(message);
    recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, messageText);

    // AI 闲聊回复：用户回复机器人、或者消息里 @ 了机器人 → 必回；否则普通发言
    // 按 AI_REPLY_PROBABILITY 概率触发。命中后就不再走下面的洗澡/随机复读，
    // 免得一条消息既被 AI 回又被复读。
    const repliedTo: any = message.reply_to_message;
    const isReplyToBot: boolean = !!repliedTo && repliedTo.from?.id === ctx.me.id;
    const isMentioned: boolean = isBotMentioned(message, ctx.me.username);

    // 消息里 @ 了别人（非机器人自己）时不参与随机搭话的概率判定——见
    // mentionsOtherUser 注释；不影响上面 isReplyToBot/isMentioned 这两条
    // 本就明确指向机器人的必回路径。
    const isRandomTrigger: boolean =
      !isReplyToBot && !isMentioned && !isQuiet &&
      !mentionsOtherUser(message, ctx.me.username) &&
      Math.random() < AI_REPLY_PROBABILITY &&
      tryClaimUserRandomReply(chatId, speaker.id);

    if (isReplyToBot || isMentioned || isRandomTrigger) {
      generateAndSendReply(chatId, message.message_id, isReplyToBot ? repliedTo.text : undefined, isRandomTrigger);
      return;
    }
  } else if (!isPrivateChat && !activeCopy && aiChatEnabled && message.sticker) {
    // 贴纸消息没有文本，但其元数据（情绪 emoji、所属贴纸包）对 AI 理解群里的
    // 情绪走向有参考价值：以描述行记入对话缓存，只当上下文，不触发 AI 回复；
    // 也不 return——后面的随机复读本来就对贴纸生效，行为保持不变。
    const speaker = resolveSpeaker(message);
    recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, describeStickerForContext(message.sticker));
  }

  // 没有复读对象时，说到洗澡/泡澡/冲凉就回一句「看看」（触发词规则见
  // consts/auto.ts 的 BATH_TRIGGER_PATTERN 注释）。以 / 开头的是指令（未注册的、
  // 或发给其他机器人的指令不会被 bot.command 拦截，会落到这里），与
  // echoMessage 的「不复读指令消息」保持一致，不触发。私聊不触发——与 AI
  // 随机插话同理，这些刷存在感的行为都是群聊语境的。
  if (!isPrivateChat && !activeCopy && !isQuiet && typeof message.text === "string" && !message.text.startsWith("/") && message.text.length <= BATH_TRIGGER_MAX_MESSAGE_LENGTH && BATH_TRIGGER_PATTERN.test(message.text)) {
    const sentMessageId: number | undefined = await sendMessage(chatId, "看看", message.message_id);
    // 自录进 AI 对话缓存，让模型知道自己刚说过这句——不然它凭空多出一句
    // 不知道是谁说的「看看」，后续被问起时接不上。isBotOwnMessage 那道门
    // 只挡自己消息的回弹（频道自回环）重新触发，记忆本身还是要留的
    // （短期进滚动缓存，随批次轮换自然被压缩进中期摘要，见
    // aiChatWorker.ts 的 recordChatMessage/scheduleRotation）。
    if (aiChatEnabled && sentMessageId !== undefined) {
      recordChatMessage(chatId, ctx.me.id, ctx.me.first_name, "", "看看");
    }
    return;
  }

  // 没有复读对象时的随机复读（私聊不触发，同上）。无需担心和其他机器人形成
  // 复读循环：Telegram 保证机器人收不到其他机器人发的消息（官方为防止 bot
  // 互相触发死循环的设计）；普通群消息里自己发的也不会作为更新推送回来，
  // 频道场景的例外由 isBotOwnMessage 挡住（见其注释）。
  if (!isPrivateChat && !activeCopy && !isQuiet && hasCopyableContent(message) && Math.random() < RANDOM_ECHO_PROBABILITY) {
    const mode: CopyMode | undefined = pickRandom(RANDOM_ECHO_MODES);
    const echoedText: string | undefined = await echoMessage(chatId, message, mode);
    // 同上，自录复读出去的文本（纯媒体复读没有文本可录，保持沉默）。
    if (aiChatEnabled && echoedText !== undefined) {
      recordChatMessage(chatId, ctx.me.id, ctx.me.first_name, "", echoedText);
    }
  }
}
