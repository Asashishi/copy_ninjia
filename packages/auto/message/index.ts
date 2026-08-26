import type { Context } from "grammy";
import type { Message } from "@grammyjs/types";
import { isAiChatActiveIn } from "../../aiChat/availability";
import { AI_REPLY_PROBABILITY_BASE_INITIAL } from "../../consts/aiChat/rateLimit";
import { recordChatTitleFromChat } from "../../infra/chatTitle";
import {
  activeCopyModeIn,
  activeCopyTargetIdIn,
  getChatState,
} from "../../infra/storage/stateStore";
import { forumTopicThreadId } from "../../libs/forumTopic";
import { isQuietUntilActive } from "../../libs/chatState";
import type { AiBotInfo } from "../../types/aiChat/protocol";
import type { MessageTriggerContext } from "../../types/auto";
import type { ChatState } from "../../types/chatState";
import { cacheSender } from "../../users/senderIdentity";
import { handleAnimationMessage } from "./animation";
import { observeGroupMessageForAiReply } from "./aiReplyActivity";
import { echoMessage, resolveEffectiveCopyMode } from "./echo";
import {
  isBotOwnMessage,
  needsBotOwnMessageWait,
  waitForBotOwnMessage,
} from "../../infra/selfSentTracker";
import { recordSelfInlineResult } from "./guards";
import { handlePhotoMessage } from "./photo";
import { handleProactiveMessageActions } from "./proactive";
import { resolveQaDirectAnswer, sendQaDirectAnswer } from "./qaDirectAnswer";
import { handlePrivateProxySend } from "./proxySend";
import { handleStickerMessage } from "./sticker";
import { handleTextMessage } from "./text";
import { createMessageTriggerContext } from "./triggerContext";
import { handleVoiceMessage } from "./voice";

/**
 * 消息自动流水线的编排层。各载荷 handler 只负责自己的记录与触发语义；这里
 * 保留跨领域的固定顺序：标题/自回弹门禁 → 活跃度 → 复制目标 → 私聊中转 →
 * 问答直答 → AI 文本或媒体 → 群聊主动行为。
 *
 * 媒体 handler 的分派顺序按「一条消息只可能是其中一种载荷」写成 else-if 链；
 * 语音排在最后，与它在群里的出现频率一致（前面几种命中就不再往下判）。
 */
export async function handleIncomingMessage(ctx: Context): Promise<void> {
  const message: Message | undefined = ctx.msg;
  if (!message) return;

  recordChatTitleFromChat(message.chat);
  const botIdentity: AiBotInfo = ctx.me;

  // 内联结果要自录入上下文但不触发主动行为；普通自发消息回弹则完全忽略。
  if (message.via_bot?.id === botIdentity.id) {
    recordSelfInlineResult(message, botIdentity);
    return;
  }
  if (isBotOwnMessage(message)) return;
  if (needsBotOwnMessageWait(message) && await waitForBotOwnMessage(message)) return;

  const chatId: number = message.chat.id;
  const senderId: number | undefined = cacheSender(message);
  const state: Readonly<ChatState> = getChatState(chatId);
  /**
   * 本条消息统一的「现在」，显式传给下面两个吃 now 的判定。
   *
   * 活跃度入窗与安静期判定必须使用同一时刻，不能因两次 Date.now() 横跨毫秒边界。
   * 两个热函数都显式接收 now，避免在被调方默认参数中重复读取墙钟。
   */
  const now: number = Date.now();

  // 所有可见群消息都先计入一小时滑动活跃度，即使当前正在复读或 AI 已关闭。
  const aiReplyProbability: number =
    message.chat.type === "group" || message.chat.type === "supergroup"
      ? observeGroupMessageForAiReply(chatId, now)
      : 1 / AI_REPLY_PROBABILITY_BASE_INITIAL;

  const copyTargetId: number | undefined = activeCopyTargetIdIn(chatId);
  if (copyTargetId !== undefined && senderId === copyTargetId) {
    await echoMessage({
      chatId,
      message,
      // 上一行已确认本群确有目标，这里取模式才有意义（见 activeCopyModeIn）。
      mode: resolveEffectiveCopyMode(chatId, activeCopyModeIn(chatId)),
      expectedTargetId: copyTargetId,
      messageThreadId: forumTopicThreadId(message),
    });
    return;
  }

  if (message.chat.type === "private") {
    await handlePrivateProxySend(message);
    return;
  }

  // 群问答直答：与登记问题一字不差时直接回答，不进 AI，也不受 @/回复/随机插话
  // 那套触发条件约束。必须排在下面的 AI 触发之前——用户明确要求「完全一致就
  // 直接查询返回」，走到 AI 就等于多付一次模型调用去回答一个已经写死的答案。
  // 只对已接管的群生效；本群没登记过问答时 resolveQaDirectAnswer 在第一行返回。
  if (state.isInitEnabled === true) {
    // 同步判定：未命中就是一次 Map.get 返回 undefined，不分配 promise。
    const qaAnswer: string | undefined = resolveQaDirectAnswer(
      chatId,
      message,
      botIdentity.username
    );
    if (qaAnswer !== undefined) {
      await sendQaDirectAnswer({
        chatId,
        replyToMessageId: message.message_id,
        answer: qaAnswer,
        messageThreadId: forumTopicThreadId(message),
      });
      return;
    }
  }

  const isQuiet: boolean = isQuietUntilActive(state.quietUntil, now);
  // 凭据缺失时这里恒为 false：既不投喂 Worker（它根本没启动），也让下面的
  // 主动行为回到「AI 关闭」那条分支——随机复读仍照常，见 aiChat/availability.ts。
  const aiChatEnabled: boolean = isAiChatActiveIn(chatId);

  if (copyTargetId === undefined && aiChatEnabled) {
    const triggerContext: MessageTriggerContext = createMessageTriggerContext({
      message,
      bot: botIdentity,
      now,
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
    } else if (message.voice) {
      shouldStop = handleVoiceMessage(triggerContext);
    }
    if (shouldStop) return;
  }

  // 复制目标活动期间禁止本群其它主动行为；无目标时才处理洗澡触发，
  // 并且只在 AI 关闭时允许随机复读。
  if (copyTargetId === undefined) {
    const proactiveAction: Promise<void> | undefined =
      handleProactiveMessageActions({ message, bot: botIdentity, isQuiet, aiChatEnabled });
    if (proactiveAction !== undefined) await proactiveAction;
  }
}
