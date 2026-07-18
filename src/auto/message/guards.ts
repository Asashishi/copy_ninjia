import type { Message } from "@grammyjs/types";
import { recordChatMessage } from "../../aiChat";
import { isSelfSent } from "../../infra/selfSentTracker";
import { getActiveCopyIn, getChatState } from "../../infra/storage/stateStore";
import { stripLuckReceipt } from "../../libs/luckReceipt";
import type { BotIdentity } from "./triggerContext";

/** 识别机器人自己发送内容的频道/关联讨论组回弹。 */
export function isBotOwnMessage(message: Message): boolean {
  if (isSelfSent(message.chat.id, message.message_id)) return true;
  const origin = message.forward_origin;
  return message.is_automatic_forward === true &&
    origin?.type === "channel" &&
    isSelfSent(origin.chat.id, origin.message_id);
}

/** 内联结果自录入 AI 上下文，但不再触发任何主动行为。 */
export function recordSelfInlineResult(message: Message, bot: BotIdentity): void {
  if (message.chat.type === "private" || typeof message.text !== "string") return;
  const chatId: number = message.chat.id;
  if (getActiveCopyIn(chatId) || getChatState(chatId).isAIChatEnabled !== true) return;
  recordChatMessage(
    chatId,
    bot.id,
    bot.firstName,
    "",
    bot.username,
    stripLuckReceipt(message.text)
  );
}
