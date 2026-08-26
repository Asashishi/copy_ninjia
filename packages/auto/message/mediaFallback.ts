import { generateAndSendReply, recordChatMessage } from "../../aiChat";
import { buildAiRecordMessage } from "./recordContext";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { MessageTriggerContext } from "../../types/auto";

/**
 * 媒体解析不出视觉素材时的统一兜底。
 *
 * sticker.ts、animation.ts 与 voice.ts 共用此边界：先把一行纯文本占位记进 AI
 * 上下文，再判断是否需要回复。「直接唤起时必须回一句」只能在这里定义。
 *
 * 不把下面那半段（掷骰 + recordChatMedia + 返回值）一起收进来：那一段各 handler
 * 的差异正是 media 载荷本身；该载荷必须在调用点一次写全，不经半成品对象展开。
 */
export interface ReplyToUnresolvableMediaParams {
  context: MessageTriggerContext;
  speaker: AiSpeakerSnapshot;
  /** 记进上下文的占位文本，由各 handler 按自己的载荷类型给出。 */
  text: string;
}

/**
 * 记一行占位文本；只有直接唤起（回复机器人或 @ 机器人）才照样回一句——真人在
 * 等回应，「已读不回」比回一句「这条听不了」更糟。
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
    // 字段一律写全（缺省显式 undefined），不用条件展开：五个入口共用同一个隐藏类，
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
