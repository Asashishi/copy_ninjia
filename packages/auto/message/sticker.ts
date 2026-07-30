import { generateAndSendReply, recordChatMedia, recordChatMessage } from "../../aiChat";
import { describeStickerForContext, pickStickerVisionSource } from "../../aiChat/ai/stickers/describe";
import { resolveSpeaker } from "./facts";
import { buildAiRecordContext } from "./recordContext";
import type { MessageTriggerContext } from "./triggerContext";
import { claimRandomMediaTrigger } from "./triggerPolicy";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { TelegramVisionSource } from "../../types/media";

/** 记录贴纸元数据/视觉描述并调度直接回复或随机评价。 */
export function handleStickerMessage(context: MessageTriggerContext): boolean {
  const { message, chatId, directTrigger }: MessageTriggerContext = context;
  if (!message.sticker) return false;

  const speaker: AiSpeakerSnapshot = resolveSpeaker(message);
  const fallbackText: string = describeStickerForContext(message.sticker);
  const visionSource: TelegramVisionSource | null = pickStickerVisionSource(message.sticker);
  if (!visionSource) {
    recordChatMessage({
      ...buildAiRecordContext(context, speaker),
      text: fallbackText,
    });
    if (!directTrigger) return false;
    generateAndSendReply({
      chatId,
      triggerSenderId: speaker.id,
      replyToMessageId: message.message_id,
      imageGenerationRequested: true,
    });
    return true;
  }

  const { candidate: commentOnResolveCandidate, claimed: claimedRandomTrigger }: { candidate: boolean; claimed: boolean; } = claimRandomMediaTrigger(context, speaker.id);
  recordChatMedia({
    kind: "sticker",
    ...buildAiRecordContext(context, speaker),
    caption: "",
    fileId: visionSource.fileId,
    fileUniqueId: visionSource.fileUniqueId,
    width: visionSource.width,
    height: visionSource.height,
    commentOnResolve: claimedRandomTrigger,
    imageGenerationRequested: directTrigger !== undefined,
    stickerFallbackText: fallbackText,
    directTrigger,
  });
  return directTrigger !== undefined || commentOnResolveCandidate;
}
