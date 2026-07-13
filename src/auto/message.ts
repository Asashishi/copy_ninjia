import type { Context } from "grammy";
import type { CachedUser, ChatState, CopyMode } from "../types";
import { getChatState } from "../infra/storage";
import { sendMessage, copyMessage } from "../infra/telegram";
import { applyCopyModeTransform } from "../copy/copyModes";
import { cacheSender } from "../users/senderIdentity";
import { recordChatMessage, generateAndSendReply } from "../aiChat";
import { AI_REPLY_PROBABILITY } from "../consts/aiChat";
import {
  BATH_TRIGGER_PATTERN,
  RANDOM_ECHO_MODES,
  RANDOM_ECHO_PROBABILITY,
  USER_RANDOM_REPLY_COOLDOWN_MS,
} from "../consts/auto";
import { userRandomReplyTimes } from "../cache/auto";
import { describeStickerForContext } from "../ai/stickerSets";
import { pickRandom } from "../libs/random";

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
 * 记录会在冷却期满后自动从 Map 中清理（仅当期间没有更新的记录覆盖它），
 * 避免长期运行下的内存泄漏。
 */
function tryClaimUserRandomReply(chatId: number, speaker: { id: number; firstName: string; lastName: string }): boolean {
  const key: string = `${chatId}_${speaker.id}_${speaker.firstName}_${speaker.lastName}`;
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
 * 将一条消息复读回它所在的聊天，并按给定模式做文本变换。
 * @param mode 要应用的文本变换（undefined 表示原样复读）。
 */
async function echoMessage(chatId: number, message: any, mode: CopyMode | undefined): Promise<void> {
  const text: string = message.text || "";
  // 不复读指令消息，防止指令无限解析
  if (text.startsWith("/")) return;

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
    await sendMessage(chatId, transformed);
  } else {
    // 无变换模式、非纯文本消息、或变换本身失败（如翻译出错）都退化为原样转发。
    await copyMessage(chatId, chatId, message.message_id);
  }
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
 * 正在被复制的目标，则将其复读回同一个聊天；如果本群当前没有复制目标，则以
 * RANDOM_ECHO_PROBABILITY 的概率随机挑一种模式复读这条消息（东一榔头西一棒子
 * 地刷存在感）。
 */
export async function handleIncomingMessage(
  ctx: Context,
  users: Record<string, CachedUser>,
  chatStates: Map<number, ChatState>
): Promise<void> {
  const message: any = ctx.msg;
  if (!message) return;

  const chatId: number = message.chat.id;
  const senderId: number | undefined = cacheSender(message, users);
  const state: ChatState = getChatState(chatStates, chatId);

  // 检查是否需要复读当前目标（用户或频道皮套）的消息
  if (state.isCopying && state.copiedUserId && senderId === state.copiedUserId) {
    await echoMessage(chatId, message, state.copyMode);
    return;
  }

  // /quiet 静默期内暂停一切主动刷存在感的行为（AI 随机插话、洗澡「看看」、
  // 随机复读），只保留被动触发（回复机器人 / @ 机器人）和指令。
  const isQuiet: boolean = (state.quietUntil ?? 0) > Date.now();

  // AI 相关逻辑仅在「群聊」且「没有复制对象」时进行：私聊消息不触发（机器人在
  // 私聊里没有群聊上下文，也不该在 DM 里自动搭话）；复制期间机器人正忙着复读
  // 目标，既不攒对话缓存也不触发 AI 回复，免得跟复读抢戏。
  const isPrivateChat: boolean = message.chat.type === "private";
  const messageText: string | undefined = typeof message.text === "string" ? message.text : undefined;
  if (!isPrivateChat && !state.isCopying && messageText && !messageText.startsWith("/")) {
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

    const isRandomTrigger: boolean =
      !isReplyToBot && !isMentioned && !isQuiet &&
      Math.random() < AI_REPLY_PROBABILITY &&
      tryClaimUserRandomReply(chatId, speaker);

    if (isReplyToBot || isMentioned || isRandomTrigger) {
      generateAndSendReply(chatId, message.message_id, isReplyToBot ? repliedTo.text : undefined, isRandomTrigger);
      return;
    }
  } else if (!isPrivateChat && !state.isCopying && message.sticker) {
    // 贴纸消息没有文本，但其元数据（情绪 emoji、所属贴纸包）对 AI 理解群里的
    // 情绪走向有参考价值：以描述行记入对话缓存，只当上下文，不触发 AI 回复；
    // 也不 return——后面的随机复读本来就对贴纸生效，行为保持不变。
    const speaker = resolveSpeaker(message);
    recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, describeStickerForContext(message.sticker));
  }

  // 没有复读对象时，有人说到洗澡/泡澡/冲凉就回一句「看看」，简繁体都认。
  // 「洗/泡」和「澡」之间只允许插入白名单里的助词/修饰字（最多 4 个），
  // 覆盖「洗个澡 / 洗個澡 / 洗了个澡 / 洗完澡 / 洗一个热水澡 / 泡个澡」这类
  // 说法，同时挡住「洗刷刷澡堂子见」这种字面撞上的误伤（洗、泡、澡三字
  // 简繁同形，冲凉的繁体是沖涼）。只对短消息（≤15 字）触发，避免长文里
  // 偶然带出也被打扰。
  // 以 / 开头的是指令（未注册的、或发给其他机器人的指令不会被 bot.command
  // 拦截，会落到这里），与 echoMessage 的「不复读指令消息」保持一致，不触发。
  if (!state.isCopying && !isQuiet && typeof message.text === "string" && !message.text.startsWith("/") && message.text.length <= 15 && BATH_TRIGGER_PATTERN.test(message.text)) {
    await sendMessage(chatId, "看看", message.message_id);
    return;
  }

  // 没有复读对象时的随机复读。无需担心和其他机器人形成复读循环：Telegram
  // 保证机器人收不到其他机器人发的消息（官方为防止 bot 互相触发死循环的设计），
  // 自己发的消息也不会作为更新推送回来。
  if (!state.isCopying && !isQuiet && hasCopyableContent(message) && Math.random() < RANDOM_ECHO_PROBABILITY) {
    const mode: CopyMode | undefined = pickRandom(RANDOM_ECHO_MODES);
    await echoMessage(chatId, message, mode);
  }
}
