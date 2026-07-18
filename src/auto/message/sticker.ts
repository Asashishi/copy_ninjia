import { generateAndSendReply, recordChatMedia, recordChatMessage } from "../../aiChat";
import { describeStickerForContext, pickStickerVisionSource } from "../../ai/stickers/sets";
import { resolveSpeaker } from "./facts";
import type { MessageTriggerContext } from "./triggerContext";
import { shouldAttemptRandomTrigger, tryClaimUserReplyTrigger } from "./triggerPolicy";

/** 记录贴纸元数据/视觉描述并调度直接回复或随机评价。 */
export function handleStickerMessage(context: MessageTriggerContext): boolean {
  const { message, chatId, directMediaTrigger } = context;
  if (!message.sticker) return false;

  const speaker = resolveSpeaker(message);
  const fallbackText: string = describeStickerForContext(message.sticker);
  const visionSource = pickStickerVisionSource(message.sticker);
  if (!visionSource) {
    recordChatMessage(chatId, speaker.id, speaker.firstName, speaker.lastName, speaker.username, fallbackText);
    if (!directMediaTrigger) return false;
    generateAndSendReply(chatId, message.message_id, directMediaTrigger.repliedBotText);
    return true;
  }

  const commentOnResolveCandidate: boolean = shouldAttemptRandomTrigger({
    directTrigger: directMediaTrigger,
    isQuiet: context.isQuiet,
    hasOtherMention: context.hasOtherMention,
    repliesToSelf: context.repliesToSelf,
    probability: context.aiReplyProbability,
  });
  const claimedRandomTrigger: boolean = commentOnResolveCandidate &&
    tryClaimUserReplyTrigger(chatId, speaker.id);
  recordChatMedia(
    "sticker",
    chatId,
    speaker.id,
    speaker.firstName,
    speaker.lastName,
    speaker.username,
    "",
    visionSource.fileId,
    visionSource.fileUniqueId,
    message.message_id,
    claimedRandomTrigger,
    fallbackText,
    directMediaTrigger
  );
  return directMediaTrigger !== undefined || commentOnResolveCandidate;
}
