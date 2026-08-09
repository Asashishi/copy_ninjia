import { generateAndSendReply, recordChatMedia, recordChatMessage } from "../../aiChat";
import { pickAnimationVisionSource, resolveSpeaker } from "./facts";
import { buildAiRecordMediaMessage, buildAiRecordMessage } from "./recordContext";
import type { MessageTriggerContext } from "../../types/auto";
import { claimRandomMediaTrigger } from "./triggerPolicy";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { TelegramVisionSource } from "../../types/media";

/** 记录 GIF 缩略图描述；无缩略图时退回纯文本上下文。 */
export function handleAnimationMessage(context: MessageTriggerContext): boolean {
  const { message, chatId, directTrigger }: MessageTriggerContext = context;
  if (!message.animation) return false;

  const speaker: AiSpeakerSnapshot = resolveSpeaker(message);
  const caption: string = typeof message.caption === "string" ? message.caption : "";
  const visionSource: TelegramVisionSource | null = pickAnimationVisionSource(message.animation);
  if (!visionSource) {
    recordChatMessage(buildAiRecordMessage({
      context,
      speaker,
      text: caption ? `[GIF] ${caption}` : "[GIF]",
    }));
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
  recordChatMedia(buildAiRecordMediaMessage({
    context,
    speaker,
    media: {
      kind: "animation",
      caption,
      fileId: visionSource.fileId,
      fileUniqueId: visionSource.fileUniqueId,
      width: visionSource.width,
      height: visionSource.height,
      commentOnResolve: claimedRandomTrigger,
      imageGenerationRequested: directTrigger !== undefined,
      stickerFallbackText: undefined,
      voiceMime: undefined,
      voiceDurationSeconds: 0,
    },
  }));
  return directTrigger !== undefined || commentOnResolveCandidate;
}
