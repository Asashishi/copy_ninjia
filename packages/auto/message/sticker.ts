import { recordChatMedia } from "../../aiChat";
import { describeStickerForContext, pickStickerVisionSource } from "../../aiChat/ai/stickers/describe";
import { resolveSpeaker } from "./facts";
import { buildAiRecordMediaMessage } from "./recordContext";
import { replyToUnresolvableMedia } from "./mediaFallback";
import type { MessageTriggerContext } from "../../types/auto";
import { claimRandomMediaTrigger } from "./triggerPolicy";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { TelegramVisionSource } from "../../types/media";

/** 记录贴纸元数据/视觉描述并调度直接回复或随机评价。 */
export function handleStickerMessage(context: MessageTriggerContext): boolean {
  const { message, directTriggerReason }: MessageTriggerContext = context;
  if (!message.sticker) return false;

  const speaker: AiSpeakerSnapshot = resolveSpeaker(message);
  const fallbackText: string = describeStickerForContext(message.sticker);
  const visionSource: TelegramVisionSource | null = pickStickerVisionSource(message.sticker);
  if (!visionSource) {
    return replyToUnresolvableMedia({ context, speaker, text: fallbackText });
  }

  const { candidate: commentOnResolveCandidate, claimed: claimedRandomTrigger }: { candidate: boolean; claimed: boolean; } = claimRandomMediaTrigger(context, speaker.id);
  recordChatMedia(buildAiRecordMediaMessage({
    context,
    speaker,
    media: {
      kind: "sticker",
      caption: "",
      fileId: visionSource.fileId,
      fileUniqueId: visionSource.fileUniqueId,
      width: visionSource.width,
      height: visionSource.height,
      commentOnResolve: claimedRandomTrigger,
      imageGenerationRequested: directTriggerReason !== undefined,
      stickerFallbackText: fallbackText,
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    },
  }));
  return directTriggerReason !== undefined || commentOnResolveCandidate;
}
