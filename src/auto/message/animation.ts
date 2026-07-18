import { generateAndSendReply, recordChatMedia, recordChatMessage } from "../../aiChat";
import { pickAnimationVisionSource, resolveSpeaker } from "./facts";
import type { MessageTriggerContext } from "./triggerContext";
import { shouldAttemptRandomTrigger, tryClaimUserReplyTrigger } from "./triggerPolicy";

/** 记录 GIF 缩略图描述；无缩略图时退回纯文本上下文。 */
export function handleAnimationMessage(context: MessageTriggerContext): boolean {
  const { message, chatId, directMediaTrigger } = context;
  if (!message.animation) return false;

  const speaker = resolveSpeaker(message);
  const caption: string = typeof message.caption === "string" ? message.caption : "";
  const visionSource = pickAnimationVisionSource(message.animation);
  if (!visionSource) {
    recordChatMessage(
      chatId,
      speaker.id,
      speaker.firstName,
      speaker.lastName,
      speaker.username,
      caption ? `[GIF] ${caption}` : "[GIF]"
    );
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
    "animation",
    chatId,
    speaker.id,
    speaker.firstName,
    speaker.lastName,
    speaker.username,
    caption,
    visionSource.fileId,
    visionSource.fileUniqueId,
    message.message_id,
    claimedRandomTrigger,
    undefined,
    directMediaTrigger
  );
  return directMediaTrigger !== undefined || commentOnResolveCandidate;
}
