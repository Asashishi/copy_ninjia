import { generateAndSendReply, recordChatMedia, recordChatMessage } from "../../aiChat";
import { pickAnimationVisionSource, resolveSpeaker } from "./facts";
import type { MessageTriggerContext } from "./triggerContext";
import { claimRandomMediaTrigger } from "./triggerPolicy";

/** 记录 GIF 缩略图描述；无缩略图时退回纯文本上下文。 */
export function handleAnimationMessage(context: MessageTriggerContext): boolean {
  const { message, chatId, directMediaTrigger } = context;
  if (!message.animation) return false;

  const speaker = resolveSpeaker(message);
  const caption: string = typeof message.caption === "string" ? message.caption : "";
  const visionSource = pickAnimationVisionSource(message.animation);
  if (!visionSource) {
    recordChatMessage({
      chatId,
      senderId: speaker.id,
      firstName: speaker.firstName,
      lastName: speaker.lastName,
      username: speaker.username,
      text: caption ? `[GIF] ${caption}` : "[GIF]",
    });
    if (!directMediaTrigger) return false;
    generateAndSendReply({
      chatId,
      triggerSenderId: speaker.id,
      replyToMessageId: message.message_id,
      repliedBotText: directMediaTrigger.repliedBotText,
    });
    return true;
  }

  const { candidate: commentOnResolveCandidate, claimed: claimedRandomTrigger } = claimRandomMediaTrigger(context, speaker.id);
  recordChatMedia({
    kind: "animation",
    chatId,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    username: speaker.username,
    caption,
    fileId: visionSource.fileId,
    fileUniqueId: visionSource.fileUniqueId,
    messageId: message.message_id,
    commentOnResolve: claimedRandomTrigger,
    directTrigger: directMediaTrigger,
  });
  return directMediaTrigger !== undefined || commentOnResolveCandidate;
}
