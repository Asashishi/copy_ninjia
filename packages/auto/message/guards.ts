import type { Message } from "@grammyjs/types";
import { recordChatMessage } from "../../aiChat";
import { buildSelfRecordContext } from "../../ai/utils/selfRecord";
import { isSelfSent } from "../../infra/selfSentTracker";
import { getActiveCopyIn, getChatState } from "../../infra/storage/stateStore";
import { stripLuckReceipt } from "../../libs/luckReceipt";
import type { AiBotInfo } from "../../types/aiChat/protocol";

/** 识别机器人自己发送内容的频道/关联讨论组回弹。 */
export function isBotOwnMessage(message: Message): boolean {
  if (isSelfSent(message.chat.id, message.message_id)) return true;
  const origin = message.forward_origin;
  return message.is_automatic_forward === true &&
    origin?.type === "channel" &&
    isSelfSent(origin.chat.id, origin.message_id);
}

/** 内联结果自录入 AI 上下文，但不再触发任何主动行为。 */
export function recordSelfInlineResult(message: Message, bot: AiBotInfo): void {
  if (message.chat.type === "private" || typeof message.text !== "string") return;
  const chatId: number = message.chat.id;
  if (getActiveCopyIn(chatId) || getChatState(chatId).isAIChatEnabled !== true) return;
  recordChatMessage({
    ...buildSelfRecordContext({ chatId, self: bot, messageId: message.message_id }),
    text: stripLuckReceipt(message.text),
  });
}
