import { generateAndSendReply, recordChatMessage } from "../../aiChat";
import { buildAiRecordMessage } from "./recordContext";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { MessageTriggerContext } from "../../types/auto";

/** replyToUnresolvableMedia 的入参。 */
export interface ReplyToUnresolvableMediaParams {
  context: MessageTriggerContext;
  speaker: AiSpeakerSnapshot;
  /** 记进上下文的占位文本，由各 handler 按自己的载荷类型给出。 */
  text: string;
}

/**
 * 媒体解析不出视觉素材时的统一兜底，sticker.ts、animation.ts 与 voice.ts 共用：先把一行
 * 纯文本占位记进 AI 上下文；只有直接唤起（回复机器人或 @ 机器人）才再发起一次回复。
 * @returns true 表示本条消息已被接管，调用方应停止后续主动行为。
 */
export function replyToUnresolvableMedia({
  context,
  speaker,
  text,
}: ReplyToUnresolvableMediaParams): boolean {
  recordChatMessage(buildAiRecordMessage({ context, speaker, text }));
  if (context.directTriggerReason === undefined) return false;
  generateAndSendReply({
    // 字段写全（缺省显式 undefined），不用条件展开，各入口共用同一个 hidden class，
    // 口径同 auto/message/text.ts 与 recordContext.ts。
    chatId: context.chatId,
    triggerSenderId: speaker.id,
    replyToMessageId: context.message.message_id,
    imageGenerationRequested: true,
    imageGenerationReference: undefined,
    isRandomTrigger: false,
    messageThreadId: context.messageThreadId,
  });
  return true;
}
