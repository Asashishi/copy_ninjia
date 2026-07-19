import { generateAndSendReply, recordChatMedia, recordChatMessage } from "../../aiChat";
import { describeStickerForContext, pickStickerVisionSource } from "../../ai/stickers/sets";
import { resolveSpeaker } from "./facts";
import type { MessageTriggerContext } from "./triggerContext";
import { claimRandomMediaTrigger } from "./triggerPolicy";

/** 记录贴纸元数据/视觉描述并调度直接回复或随机评价。 */
export function handleStickerMessage(context: MessageTriggerContext): boolean {
  const { message, chatId, directMediaTrigger } = context;
  if (!message.sticker) return false;

  const speaker = resolveSpeaker(message);
  const fallbackText: string = describeStickerForContext(message.sticker);
  const visionSource = pickStickerVisionSource(message.sticker);
  if (!visionSource) {
    recordChatMessage({
      chatId,
      senderId: speaker.id,
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      username: speaker.username,
      text: fallbackText,
    });
    if (!directMediaTrigger) return false;
    generateAndSendReply({
      chatId,
      triggerSenderId: speaker.id,
      replyToMessageId: message.message_id,
      repliedBotText: directMediaTrigger.repliedBotText,
      imageGenerationRequested: false,
    });
    return true;
  }

  const { candidate: commentOnResolveCandidate, claimed: claimedRandomTrigger } = claimRandomMediaTrigger(context, speaker.id);
  recordChatMedia({
    kind: "sticker",
    chatId,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    username: speaker.username,
    caption: "",
    fileId: visionSource.fileId,
    fileUniqueId: visionSource.fileUniqueId,
    messageId: message.message_id,
    commentOnResolve: claimedRandomTrigger,
    imageGenerationRequested: false,
    stickerFallbackText: fallbackText,
    directTrigger: directMediaTrigger,
  });
  return directMediaTrigger !== undefined || commentOnResolveCandidate;
}
