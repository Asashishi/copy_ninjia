import { recordChatMedia } from "../../aiChat";
import { pickPhotoFile, resolveSpeaker } from "./facts";
import { buildAiRecordMediaMessage } from "./recordContext";
import type { MessageTriggerContext } from "../../types/auto";
import { claimRandomMediaTrigger } from "./triggerPolicy";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { TelegramVisionSource } from "../../types/media";

/** 记录图片占位/描述，并调度直接回复或随机评价。 */
export function handlePhotoMessage(context: MessageTriggerContext): boolean {
  const { message, directTrigger }: MessageTriggerContext = context;
  if (!Array.isArray(message.photo) || message.photo.length === 0) return false;

  const speaker: AiSpeakerSnapshot = resolveSpeaker(message);
  const { candidate: commentOnResolveCandidate, claimed: claimedRandomTrigger }: { candidate: boolean; claimed: boolean; } = claimRandomMediaTrigger(context, speaker.id);
  const photoFile: TelegramVisionSource = pickPhotoFile(message.photo);
  const caption: string = typeof message.caption === "string" ? message.caption : "";
  recordChatMedia(buildAiRecordMediaMessage({
    context,
    speaker,
    media: {
      kind: "photo",
      caption,
      fileId: photoFile.fileId,
      fileUniqueId: photoFile.fileUniqueId,
      width: photoFile.width,
      height: photoFile.height,
      commentOnResolve: claimedRandomTrigger,
      // 直接回复/@ 只开放工具资格，具体是否要编辑图片交给模型判断。
      imageGenerationRequested: directTrigger !== undefined,
      stickerFallbackText: undefined,
    },
  }));
  return directTrigger !== undefined || commentOnResolveCandidate;
}
