import { generateAndSendReply, recordChatMessage } from "../../aiChat";
import { resolveSpeaker } from "./facts";
import type { MessageTriggerContext } from "./triggerContext";
import { shouldAttemptRandomTrigger, tryClaimUserReplyTrigger } from "./triggerPolicy";

/** 记录普通文字并处理直接回复/@ 与随机搭话。true 表示终止后续主动行为。 */
export function handleTextMessage(context: MessageTriggerContext): boolean {
  const { message, chatId } = context;
  if (typeof message.text !== "string" || message.text.startsWith("/")) return false;

  const speaker = resolveSpeaker(message);
  recordChatMessage({
    chatId,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    username: speaker.username,
    text: message.text,
  });

  if (context.directMediaTrigger) {
    generateAndSendReply({
      chatId,
      triggerSenderId: speaker.id,
      replyToMessageId: message.message_id,
      repliedBotText: context.isReplyToBot ? context.repliedTo?.text : undefined,
    });
    return true;
  }

  const isRandomTrigger: boolean = shouldAttemptRandomTrigger({
    isQuiet: context.isQuiet,
    hasOtherMention: context.hasOtherMention,
    repliesToSelf: context.repliesToSelf,
    probability: context.aiReplyProbability,
  });
  if (!isRandomTrigger) return false;
  if (tryClaimUserReplyTrigger(chatId, speaker.id)) {
    generateAndSendReply({ chatId, triggerSenderId: speaker.id, replyToMessageId: message.message_id, isRandomTrigger: true });
  }
  // 掷骰命中但个人冷却未取得时仍不随机复读，与原流水线语义一致。
  return true;
}
