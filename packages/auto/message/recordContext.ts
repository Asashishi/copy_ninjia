import type { AiRecordContext } from "../../types/aiChat/protocol";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { MessageTriggerContext } from "../../types/auto";

/** 文字与各媒体 handler 共用的 Worker 记录字段，集中保持身份和回复关系一致。 */
export function buildAiRecordContext(
  context: MessageTriggerContext,
  speaker: AiSpeakerSnapshot
): AiRecordContext {
  return {
    chatId: context.chatId,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    ...(speaker.username ? { username: speaker.username } : {}),
    messageId: context.message.message_id,
    ...(context.replyReference ? { replyTo: context.replyReference } : {}),
    ...(context.forwardedFrom ? { forwardedFrom: context.forwardedFrom } : {}),
  };
}
