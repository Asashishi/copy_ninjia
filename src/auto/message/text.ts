import { generateAndSendReply, recordChatMessage } from "../../aiChat";
import { pickStickerVisionSource } from "../../ai/stickers/sets";
import { pickPhotoFile, resolveSpeaker } from "./facts";
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
    // 这里只确认当前消息确实直接叫了机器人；是否包含生图/修图意图由模型
    // 根据本轮消息与工具说明判断，避免关键词正则漏掉自然表达。
    const repliedPhoto = Array.isArray(context.repliedTo?.photo) && context.repliedTo.photo.length > 0
      ? pickPhotoFile(context.repliedTo.photo)
      : undefined;
    const repliedSticker = context.repliedTo?.sticker
      ? pickStickerVisionSource(context.repliedTo.sticker) ?? undefined
      : undefined;
    const imageGenerationReference = repliedPhoto ?? repliedSticker;
    generateAndSendReply({
      chatId,
      triggerSenderId: speaker.id,
      replyToMessageId: message.message_id,
      repliedBotText: context.isReplyToBot ? context.repliedTo?.text : undefined,
      imageGenerationRequested: true,
      ...(imageGenerationReference ? { imageGenerationReference } : {}),
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
    generateAndSendReply({
      chatId,
      triggerSenderId: speaker.id,
      replyToMessageId: message.message_id,
      isRandomTrigger: true,
      // 没有回复/@机器人只是随机插话，不构成对生图工具的明确调用。
      imageGenerationRequested: false,
    });
  }
  // 掷骰命中但个人冷却未取得时仍不随机复读，与原流水线语义一致。
  return true;
}
