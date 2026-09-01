import type { Message } from "grammy/types";
import { recordChatMessage } from "../../aiChat";
import { isAiChatActiveIn } from "../../aiChat/availability";
import { buildSelfRecordMessage } from "../../aiChat/ai/utils/selfRecord";
import { activeCopyTargetIdIn } from "../../infra/storage/stateStore";
import { stripLuckReceipt } from "../../libs/luckReceipt";
import type { AiBotInfo } from "../../types/aiChat/protocol";

/** 内联结果自录入 AI 上下文，但不再触发任何主动行为。 */
export function recordSelfInlineResult(message: Message, bot: AiBotInfo): void {
  if (message.chat.type === "private" || typeof message.text !== "string") return;
  const chatId: number = message.chat.id;
  if (activeCopyTargetIdIn(chatId) !== undefined || !isAiChatActiveIn(chatId)) return;
  recordChatMessage(buildSelfRecordMessage({
    chatId,
    self: bot,
    messageId: message.message_id,
    text: stripLuckReceipt(message.text),
  }));
}
