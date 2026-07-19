import { recordChatMedia } from "../../aiChat";
import { pickPhotoFile, resolveSpeaker } from "./facts";
import { hasExplicitImageGenerationIntent } from "./imageGenerationIntent";
import type { MessageTriggerContext } from "./triggerContext";
import { claimRandomMediaTrigger } from "./triggerPolicy";

/** 记录图片占位/描述，并调度直接回复或随机评价。 */
export function handlePhotoMessage(context: MessageTriggerContext): boolean {
  const { message, chatId, directMediaTrigger } = context;
  if (!Array.isArray(message.photo) || message.photo.length === 0) return false;

  const speaker = resolveSpeaker(message);
  const { candidate: commentOnResolveCandidate, claimed: claimedRandomTrigger } = claimRandomMediaTrigger(context, speaker.id);
  const photoFile = pickPhotoFile(message.photo);
  const caption: string = typeof message.caption === "string" ? message.caption : "";
  recordChatMedia({
    kind: "photo",
    chatId,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    username: speaker.username,
    caption,
    fileId: photoFile.fileId,
    fileUniqueId: photoFile.fileUniqueId,
    messageId: message.message_id,
    commentOnResolve: claimedRandomTrigger,
    imageGenerationRequested: directMediaTrigger !== undefined && hasExplicitImageGenerationIntent(caption),
    directTrigger: directMediaTrigger,
  });
  return directMediaTrigger !== undefined || commentOnResolveCandidate;
}
