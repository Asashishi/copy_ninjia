import type { Message } from "@grammyjs/types";
import { recordChatMessage } from "../../aiChat";
import {
  BATH_TRIGGER_MAX_MESSAGE_LENGTH,
  BATH_TRIGGER_PATTERN,
  BATH_TRIGGER_REPLY_TEXT,
  RANDOM_ECHO_MODES,
  RANDOM_ECHO_PROBABILITY,
} from "../../consts/auto";
import { sendMessage } from "../../infra/telegram";
import { pickRandom } from "../../libs/random";
import type { CopyMode } from "../../types/chatState";
import { echoMessage, resolveEffectiveCopyMode } from "./echo";
import { hasCopyableContent } from "./facts";
import type { BotIdentity } from "./triggerContext";

/**
 * 洗澡触发和随机复读；仅由无活动复制目标的非私聊流水线调用。AI 开启时
 * 仍保留洗澡关键词响应，但禁用随机复读，避免两套随机插话机制同时运行。
 */
export async function handleProactiveMessageActions(
  message: Message,
  bot: BotIdentity,
  isQuiet: boolean,
  aiChatEnabled: boolean
): Promise<void> {
  const chatId: number = message.chat.id;
  if (
    !isQuiet &&
    typeof message.text === "string" &&
    !message.text.startsWith("/") &&
    message.text.length <= BATH_TRIGGER_MAX_MESSAGE_LENGTH &&
    BATH_TRIGGER_PATTERN.test(message.text)
  ) {
    const sentMessageId: number | undefined = await sendMessage(
      chatId,
      BATH_TRIGGER_REPLY_TEXT,
      message.message_id
    );
    if (aiChatEnabled && sentMessageId !== undefined) {
      recordChatMessage(chatId, bot.id, bot.firstName, "", bot.username, BATH_TRIGGER_REPLY_TEXT);
    }
    return;
  }

  if (
    !aiChatEnabled &&
    !isQuiet &&
    hasCopyableContent(message) &&
    Math.random() < RANDOM_ECHO_PROBABILITY
  ) {
    const mode: CopyMode | undefined = resolveEffectiveCopyMode(chatId, pickRandom(RANDOM_ECHO_MODES));
    await echoMessage(chatId, message, mode);
  }
}
