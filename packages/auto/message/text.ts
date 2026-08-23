import { generateAndSendReply, recordChatMessage } from "../../aiChat";
import { pickStickerVisionSource } from "../../aiChat/ai/stickers/describe";
import { pickPhotoFile, resolveSpeaker } from "./facts";
import { buildAiRecordMessage } from "./recordContext";
import type { MessageTriggerContext } from "../../types/auto";
import { shouldAttemptRandomTrigger, tryClaimUserReplyTrigger } from "./triggerPolicy";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { TelegramVisionSource } from "../../types/media";

/** 记录普通文字并处理直接回复/@ 与随机搭话。true 表示终止后续主动行为。 */
export function handleTextMessage(context: MessageTriggerContext): boolean {
  const { message, chatId }: MessageTriggerContext = context;
  if (typeof message.text !== "string" || message.text.startsWith("/")) return false;

  const speaker: AiSpeakerSnapshot = resolveSpeaker(message);
  recordChatMessage(buildAiRecordMessage({ context, speaker, text: message.text }));

  if (context.directTriggerReason !== undefined) {
    // 这里只确认当前消息确实直接叫了机器人；是否包含生图/修图意图由模型
    // 根据本轮消息与工具说明判断，避免关键词正则漏掉自然表达。
    const repliedPhoto: TelegramVisionSource | undefined = Array.isArray(context.repliedTo?.photo) && context.repliedTo.photo.length > 0
      ? pickPhotoFile(context.repliedTo.photo)
      : undefined;
    const repliedSticker: TelegramVisionSource | undefined = context.repliedTo?.sticker
      ? pickStickerVisionSource(context.repliedTo.sticker) ?? undefined
      : undefined;
    const imageGenerationReference: TelegramVisionSource | undefined = repliedPhoto ?? repliedSticker;
    generateAndSendReply({
      // 字段一律写全（缺省显式 undefined），不用条件展开：五个入口共用同一个
      // 隐藏类，messageIngress.ts 的解构与 Worker 侧读取才不会多态。口径同
      // auto/message/recordContext.ts。
      chatId,
      triggerSenderId: speaker.id,
      replyToMessageId: message.message_id,
      imageGenerationRequested: true,
      imageGenerationReference,
      isRandomTrigger: false,
      messageThreadId: context.messageThreadId,
    });
    return true;
  }

  const isRandomTrigger: boolean = shouldAttemptRandomTrigger(context);
  if (!isRandomTrigger) return false;
  if (tryClaimUserReplyTrigger(chatId, speaker.id, context.now)) {
    generateAndSendReply({
      chatId,
      triggerSenderId: speaker.id,
      replyToMessageId: message.message_id,
      // 没有回复/@机器人只是随机插话，不构成对生图工具的明确调用。
      imageGenerationRequested: false,
      imageGenerationReference: undefined,
      isRandomTrigger: true,
      messageThreadId: context.messageThreadId,
    });
  }
  // 掷骰命中但个人冷却未取得时仍不随机复读，与原流水线语义一致。
  return true;
}
