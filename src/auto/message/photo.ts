import { recordChatMedia } from "../../aiChat";
import { pickPhotoFile, resolveSpeaker } from "./facts";
import type { MessageTriggerContext } from "./triggerContext";
import { shouldAttemptRandomTrigger, tryClaimUserReplyTrigger } from "./triggerPolicy";

/** 记录图片占位/描述，并调度直接回复或随机评价。 */
export function handlePhotoMessage(context: MessageTriggerContext): boolean {
  const { message, chatId, directMediaTrigger } = context;
  if (!Array.isArray(message.photo) || message.photo.length === 0) return false;

  const speaker = resolveSpeaker(message);
  const commentOnResolveCandidate: boolean = shouldAttemptRandomTrigger({
    directTrigger: directMediaTrigger,
    isQuiet: context.isQuiet,
    hasOtherMention: context.hasOtherMention,
    repliesToSelf: context.repliesToSelf,
    probability: context.aiReplyProbability,
  });
  const claimedRandomTrigger: boolean = commentOnResolveCandidate &&
    tryClaimUserReplyTrigger(chatId, speaker.id);
  const photoFile = pickPhotoFile(message.photo);
  recordChatMedia(
    "photo",
    chatId,
    speaker.id,
    speaker.firstName,
    speaker.lastName,
    speaker.username,
    typeof message.caption === "string" ? message.caption : "",
    photoFile.fileId,
    photoFile.fileUniqueId,
    message.message_id,
    claimedRandomTrigger,
    undefined,
    directMediaTrigger
  );
  return directMediaTrigger !== undefined || commentOnResolveCandidate;
}
