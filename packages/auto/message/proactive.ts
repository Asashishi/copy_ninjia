import type { Message } from "@grammyjs/types";
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
import { echoMessage, resolveEffectiveCopyMode } from "./echo";
import { hasCopyableContent } from "./facts";

/**
 * 洗澡触发和随机复读；仅由无活动复制目标的非私聊流水线调用。AI 开启时
 * 仍保留洗澡关键词响应，但禁用随机复读，避免两套随机插话机制同时运行。
 */
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
    // 这条回复不挂延迟删除，会长期留在群里，因此必须自己带话题：只靠
    // reply_parameters 的话，触发它的消息被删掉时整条回复会落进 General
    // （同 performRandomEcho，见 SendMessageParams.messageThreadId）。
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

/** 随机复读命中后吸收底层消息标识，保持编排层只暴露完成信号。 */
async function performRandomEcho(
  chatId: number,
  message: Message,
  mode: CopyMode | undefined
): Promise<void> {
  await echoMessage({
    chatId,
    message,
    mode,
    messageThreadId: forumTopicThreadId(message),
  });
}

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
    const mode: CopyMode | undefined = resolveEffectiveCopyMode(chatId, pickRandom(RANDOM_ECHO_MODES));
    return performRandomEcho(chatId, message, mode);
  }
  return undefined;
}
