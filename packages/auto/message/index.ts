import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { isAiChatConfigured } from "../../aiChat/availability";
import { AI_REPLY_PROBABILITY_BASE_INITIAL } from "../../consts/aiChat/rateLimit";
import { recordChatTitleFromChat } from "../../infra/chatTitle";
import { observeMediaGroupImage } from "../../infra/mediaGroups";
import {
  activeCopyModeIn,
  activeCopyTargetIdIn,
  getChatState,
} from "../../infra/storage/stateStore";
import { forumTopicThreadId } from "../../libs/forumTopic";
import { isQuietUntilActive } from "../../libs/chatState";
import type { AiBotInfo } from "../../types/aiChat/protocol";
import type { AiTriggerPayload, MessageTriggerContext } from "../../types/auto";
import type { ChatState } from "../../types/chatState";
import type { TranslateState } from "../../types/translate";
import { activeTranslateStateIn, queueTranslateMessage } from "../../translate/message";
import { cacheSender } from "../../users/senderIdentity";
import { handleAnimationMessage } from "./animation";
import { observeGroupMessageForAiReply } from "./aiReplyActivity";
import { echoMessage } from "./echo";
import {
  isBotOwnMessage,
  needsBotOwnMessageWait,
  waitForBotOwnMessage,
} from "../../infra/selfSentTracker";
import { refreshUpdateNow, updateNow } from "../../infra/updateContext";
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
 * 判定这条消息交给哪个 AI handler；没有对应 handler（视频、文件、以 `/` 开头的
 * 文本等）返回 undefined。按「一条消息只可能是其中一种载荷」逐项判定，命中即返回。
 */
function aiTriggerPayloadOf(message: Message): AiTriggerPayload | undefined {
  if (typeof message.text === "string") {
    return message.text.startsWith("/") ? undefined : "text";
  }
  if (message.sticker) return "sticker";
  if (Array.isArray(message.photo) && message.photo.length > 0) return "photo";
  if (message.animation) return "animation";
  if (message.voice) return "voice";
  return undefined;
}

/**
 * 消息自动流水线的编排层。各载荷 handler 只负责自己的记录与触发语义；这里
 * 保留跨领域的固定顺序：标题/自回弹门禁 → 活跃度 → 翻译目标 → 复制目标 → 私聊中转 →
 * 问答直答 → AI 文本或媒体 → 群聊主动行为。
 *
 * AI 分支先由 aiTriggerPayloadOf 判定载荷，只有存在对应 handler 时才构造触发上下文。
 */
function handleAcceptedIncomingMessage(
  message: Message,
  botIdentity: AiBotInfo,
  groupState: Readonly<ChatState> | undefined
): Promise<void> | undefined {
  const chatId: number = message.chat.id;
  const senderId: number | undefined = cacheSender(message);
  // 相册里的图记进缓存，供 `/h_image add` 收齐整组；排在复读、翻译等提前返回的分支之前。
  if (message.media_group_id !== undefined) observeMediaGroupImage(message);
  const state: Readonly<ChatState> = groupState ?? getChatState(chatId);
  /**
   * 本条消息统一的「现在」，传给活跃度入窗与安静期判定。
   * 取值经 updateNow：已确证机器人是管理员的群消息在入群守卫入口已先取本条 update 的
   * 时刻（广告检测与防刷屏开关关闭时同样），其余消息在本处首次取值并留给后续调用点
   * （见 infra/updateContext.ts）。
   */
  const now: number = updateNow();

  // 所有可见群消息都先计入滑动活跃度窗口，即使当前正在复读或 AI 已关闭。
  const aiReplyProbability: number =
    message.chat.type === "group" || message.chat.type === "supergroup"
      ? observeGroupMessageForAiReply(chatId, now)
      : 1 / AI_REPLY_PROBABILITY_BASE_INITIAL;

  const copyTargetId: number | undefined = activeCopyTargetIdIn(chatId);
  const translation: TranslateState | undefined = senderId === undefined ? undefined : activeTranslateStateIn(chatId, senderId);
  // 生效的翻译目标只走翻译：同时是 copy 目标也不复读、不复制媒体；翻译整条不发送时
  // （同语种、没有文字等）这条消息同样不再往下处理。译文在按群串行的后台链里生成并发出，
  // 本条 update 不等它。
  if (translation !== undefined) {
    queueTranslateMessage({
      chatId,
      message,
      state: translation,
      messageThreadId: forumTopicThreadId(message),
    });
    return undefined;
  }
  if (copyTargetId !== undefined && senderId === copyTargetId) {
    return echoMessage({
      chatId,
      message,
      // 上一行已确认本群确有目标，这里取模式才有意义（见 activeCopyModeIn）。
      mode: activeCopyModeIn(chatId),
      expectedTargetId: copyTargetId,
      messageThreadId: forumTopicThreadId(message),
    });
  }

  if (message.chat.type === "private") {
    return handlePrivateProxySend(message);
  }

  // 群问答直答：与登记问题一字不差时直接回答，不进 AI，也不受 @/回复/随机插话
  // 的触发条件约束；排在 AI 触发之前。
  // 未接管的群已被 infra/updateGate.ts 的 shouldPassInitGate 挡在流水线之外；本群没
  // 登记过问答时 resolveQaDirectAnswer 在第一行返回。
  // 同步判定：未命中是一次 Map.get 返回 undefined，不分配 promise。
  const qaAnswer: string | undefined = resolveQaDirectAnswer(
    chatId,
    message,
    botIdentity.username
  );
  if (qaAnswer !== undefined) {
    return sendQaDirectAnswer({
      chatId,
      replyToMessageId: message.message_id,
      answer: qaAnswer,
      messageThreadId: forumTopicThreadId(message),
    }).then((): void => undefined);
  }

  const isQuiet: boolean = isQuietUntilActive(state.quietUntil, now);
  // 凭据缺失时为 false：不投喂 Worker（它没有启动），下面的主动行为走「AI 关闭」
  // 分支，随机复读照常，见 aiChat/availability.ts。
  const aiChatEnabled: boolean =
    isAiChatConfigured() && state.isAIChatEnabled === true;

  if (copyTargetId === undefined && aiChatEnabled) {
    const payload: AiTriggerPayload | undefined = aiTriggerPayloadOf(message);
    if (payload !== undefined) {
      const triggerContext: MessageTriggerContext = createMessageTriggerContext({
        message,
        bot: botIdentity,
        now,
        isQuiet,
        aiReplyProbability,
      });
      let shouldStop: boolean;
      switch (payload) {
        case "text":
          shouldStop = handleTextMessage(triggerContext);
          break;
        case "sticker":
          shouldStop = handleStickerMessage(triggerContext);
          break;
        case "photo":
          shouldStop = handlePhotoMessage(triggerContext);
          break;
        case "animation":
          shouldStop = handleAnimationMessage(triggerContext);
          break;
        case "voice":
          shouldStop = handleVoiceMessage(triggerContext);
          break;
      }
      if (shouldStop) return;
    }
  }

  // 复制目标活动期间禁止本群其它主动行为；无目标时才处理洗澡触发，
  // 并且只在 AI 关闭时允许随机复读。
  if (copyTargetId === undefined) {
    return handleProactiveMessageActions({ message, bot: botIdentity, isQuiet, aiChatEnabled });
  }
}

/**
 * 消息自动流水线的同步入口。普通消息只执行同步判定；只有真正命中 Telegram I/O
 * 或自发消息等待时才返回 Promise，供 grammY 的 MaybePromise middleware 边界接管。
 */
export function handleIncomingMessageMiddleware(ctx: Context): Promise<void> | undefined {
  const message: Message | undefined = ctx.msg;
  if (!message) return undefined;

  const chatId: number = message.chat.id;
  const groupState: Readonly<ChatState> | undefined =
    message.chat.type === "group" || message.chat.type === "supergroup"
      ? getChatState(chatId)
      : undefined;
  recordChatTitleFromChat(message.chat, groupState);
  const botIdentity: AiBotInfo = ctx.me;

  // 内联结果要自录入上下文但不触发主动行为；普通自发消息回弹则完全忽略。
  if (message.via_bot?.id === botIdentity.id) {
    recordSelfInlineResult(message, botIdentity);
    return undefined;
  }
  if (isBotOwnMessage(message)) return undefined;
  if (needsBotOwnMessageWait(message)) {
    return waitForBotOwnMessage(message).then(
      (matched: boolean): Promise<void> | undefined => {
        if (matched) return undefined;
        // 自动转发会在超级群进入这条异步路径；恢复处理读取当时现值，不沿用等待前的
        // 状态。时刻同理：rendezvous 最长等 SELF_SENT_RENDEZVOUS_TIMEOUT_MS，
        // 这里经 refreshUpdateNow 重新取一次，后续调用点使用新值。
        refreshUpdateNow();
        return handleAcceptedIncomingMessage(message, botIdentity, undefined);
      }
    );
  }

  return handleAcceptedIncomingMessage(message, botIdentity, groupState);
}
