import type { Message } from "grammy/types";
import { recordChatMessage } from "../../aiChat";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import {
  BATH_TRIGGER_MAX_MESSAGE_LENGTH,
  BATH_TRIGGER_PATTERN,
  BATH_TRIGGER_REPLY_TEXT,
  RANDOM_ECHO_MODES,
  RANDOM_ECHO_PROBABILITY,
} from "../../consts/auto";
import { sendMessage } from "../../infra/telegram";
import { forumTopicThreadId } from "../../libs/forumTopic";
import { pickRandom } from "../../libs/random";
import type { AiBotInfo } from "../../types/aiChat/protocol";
import type { CopyMode } from "../../types/chatState";
import { echoMessage } from "./echo";
import { hasCopyableContent } from "./facts";

/** handleProactiveMessageActions 的入参。 */
export interface HandleProactiveMessageActionsParams {
  message: Message;
  bot: AiBotInfo;
  isQuiet: boolean;
  aiChatEnabled: boolean;
}

/** 洗澡关键词命中后的异步发送与 AI 自消息记录。 */
async function replyToBathTrigger(
  message: Message,
  bot: AiBotInfo,
  aiChatEnabled: boolean
): Promise<void> {
  const sentMessageId: number | undefined = await sendMessage({
    chatId: message.chat.id,
    text: BATH_TRIGGER_REPLY_TEXT,
    replyToMessageId: message.message_id,
    // 这条回复长期留在群里，自带话题（同随机复读，见 SendMessageParams.messageThreadId）。
    messageThreadId: forumTopicThreadId(message),
  });
  if (aiChatEnabled && sentMessageId !== undefined) {
    recordChatMessage(buildSelfRecordMessage({
      chatId: message.chat.id,
      self: bot,
      messageId: sentMessageId,
      text: BATH_TRIGGER_REPLY_TEXT,
    }));
  }
}

/**
 * 洗澡触发和随机复读；仅由无活动复制目标的非私聊流水线调用。AI 开启时
 * 保留洗澡关键词响应，禁用随机复读。
 */
export function handleProactiveMessageActions({
  message,
  bot,
  isQuiet,
  aiChatEnabled,
}: HandleProactiveMessageActionsParams): Promise<void> | undefined {
  const chatId: number = message.chat.id;
  if (
    !isQuiet &&
    typeof message.text === "string" &&
    !message.text.startsWith("/") &&
    message.text.length <= BATH_TRIGGER_MAX_MESSAGE_LENGTH &&
    BATH_TRIGGER_PATTERN.test(message.text)
  ) {
    return replyToBathTrigger(message, bot, aiChatEnabled);
  }

  if (
    !aiChatEnabled &&
    !isQuiet &&
    hasCopyableContent(message) &&
    Math.random() < RANDOM_ECHO_PROBABILITY
  ) {
    const mode: CopyMode | undefined = pickRandom(RANDOM_ECHO_MODES);
    return echoMessage({ chatId, message, mode, messageThreadId: forumTopicThreadId(message) });
  }
  return undefined;
}
