import type { Context } from "grammy";
import type { Message } from "@grammyjs/types";
import { AI_REPLY_PROBABILITY_BASE_INITIAL } from "../../consts/aiChat/rateLimit";
import { recordChatTitleFromChat } from "../../infra/chatTitle";
import { getActiveCopyIn, getChatState } from "../../infra/storage/stateStore";
import { isQuietUntilActive } from "../../libs/chatState";
import type { ChatState } from "../../types/chatState";
import { cacheSender } from "../../users/senderIdentity";
import { handleAnimationMessage } from "./animation";
import { observeGroupMessageForAiReply } from "./aiReplyActivity";
import { echoMessage, resolveEffectiveCopyMode } from "./echo";
import { isBotOwnMessage, recordSelfInlineResult } from "./guards";
import { handlePhotoMessage } from "./photo";
import { handleProactiveMessageActions } from "./proactive";
import { handlePrivateProxySend } from "./proxySend";
import { handleStickerMessage } from "./sticker";
import { handleTextMessage } from "./text";
import {
  createMessageTriggerContext,
  type BotIdentity,
  type MessageTriggerContext,
} from "./triggerContext";

/**
 * 消息自动流水线的编排层。各载荷 handler 只负责自己的记录与触发语义；这里
 * 保留跨领域的固定顺序：标题/自回弹门禁 → 活跃度 → 复制目标 → 私聊中转 →
 * AI 文本或媒体 → 群聊主动行为。
 */
export async function handleIncomingMessage(ctx: Context): Promise<void> {
  const message: Message | undefined = ctx.msg;
  if (!message) return;

  recordChatTitleFromChat(message.chat);
  const botIdentity: BotIdentity = {
    id: ctx.me.id,
    firstName: ctx.me.first_name,
    username: ctx.me.username,
  };

  // 内联结果要自录入上下文但不触发主动行为；普通自发消息回弹则完全忽略。
  if (message.via_bot?.id === botIdentity.id) {
    recordSelfInlineResult(message, botIdentity);
    return;
  }
  if (isBotOwnMessage(message)) return;

  const chatId: number = message.chat.id;
  const senderId: number | undefined = cacheSender(message);
  const state: ChatState = getChatState(chatId);

  // 所有可见群消息都先计入一小时滑动活跃度，即使当前正在复读或 AI 已关闭。
  const aiReplyProbability: number =
    message.chat.type === "group" || message.chat.type === "supergroup"
      ? observeGroupMessageForAiReply(chatId)
      : 1 / AI_REPLY_PROBABILITY_BASE_INITIAL;

  const activeCopy = getActiveCopyIn(chatId);
  if (activeCopy && senderId === activeCopy.copiedUser.id) {
    await echoMessage({
      chatId,
      message,
      mode: resolveEffectiveCopyMode(chatId, activeCopy.copyMode),
      expectedTargetId: activeCopy.copiedUser.id,
    });
    return;
  }

  if (message.chat.type === "private") {
    await handlePrivateProxySend(message);
    return;
  }

  const isQuiet: boolean = isQuietUntilActive(state.quietUntil);
  const aiChatEnabled: boolean = state.isAIChatEnabled === true;

  if (!activeCopy && aiChatEnabled) {
    const triggerContext: MessageTriggerContext = createMessageTriggerContext({
      message,
      bot: botIdentity,
      isQuiet,
      aiReplyProbability,
    });
    let shouldStop: boolean = false;
    if (typeof message.text === "string" && !message.text.startsWith("/")) {
      shouldStop = handleTextMessage(triggerContext);
    } else if (message.sticker) {
      shouldStop = handleStickerMessage(triggerContext);
    } else if (Array.isArray(message.photo) && message.photo.length > 0) {
      shouldStop = handlePhotoMessage(triggerContext);
    } else if (message.animation) {
      shouldStop = handleAnimationMessage(triggerContext);
    }
    if (shouldStop) return;
  }

  // 复制目标活动期间禁止本群其它主动行为；无目标时才处理洗澡触发，
  // 并且只在 AI 关闭时允许随机复读。
  if (!activeCopy) {
    await handleProactiveMessageActions({ message, bot: botIdentity, isQuiet, aiChatEnabled });
  }
}
