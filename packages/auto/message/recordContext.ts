import type {
  AiRecordMediaMessage,
  AiRecordMessage,
} from "../../types/aiChat/protocol";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { MessageTriggerContext, RandomMediaTrigger } from "../../types/auto";

/**
 * 文字与各媒体 handler 共用的 Worker 记录载荷构造边界，集中保持身份和回复
 * 关系一致。
 *
 * builder 直接产出完整消息，不创建公共字段投影，也不让调用点用对象展开重建
 * 同构载荷。options 字面量不逃逸，字段按固定顺序一次写齐。
 *
 * 字段顺序即隐藏类顺序，两个 builder 的公共段必须保持一致，别只改一个。
 */
export interface BuildAiRecordMessageParams {
  context: MessageTriggerContext;
  speaker: AiSpeakerSnapshot;
  text: string;
}

/** 一条文字记录的完整 Worker 载荷。 */
export function buildAiRecordMessage({
  context,
  speaker,
  text,
}: BuildAiRecordMessageParams): AiRecordMessage {
  return {
    type: "record",
    chatId: context.chatId,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    username: speaker.username,
    messageId: context.message.message_id,
    replyTo: context.replyReference,
    forwardedFrom: context.forwardedFrom,
    persistImmediately: false,
    text,
  };
}

/**
 * 四个媒体 handler 写入 `replyTelegramBackpressured` 的构造值：直接触发或已占到
 * 随机评价名额（`claimed`）时为 false，由 aiChat/messageIngress.ts 在投递时刻覆写为
 * 实时快照；不发起回复为 undefined。
 *
 * 判定在 handler 侧算好再作为 options 字段传入，buildAiRecordMediaMessage 只做直接取值。
 */
export function mediaReplyBackpressurePlaceholder(
  context: MessageTriggerContext,
  randomTrigger: RandomMediaTrigger
): boolean | undefined {
  return context.directTriggerReason !== undefined || randomTrigger === "claimed"
    ? false
    : undefined;
}

/**
 * 媒体记录的构造参数：身份与回复关系之外，其余是逐载荷不同的字段，平铺在同一个
 * options 里直接写进载荷。
 *
 * 媒体字段从协议类型 `Pick` 派生，协议字段变化会让四个调用点在编译期同步收敛。
 * 各字段的语义（语音传 0、仅贴纸用等）由协议侧 JSDoc 统一声明。
 */
export interface BuildAiRecordMediaMessageParams extends Pick<
  AiRecordMediaMessage,
  | "kind"
  | "caption"
  | "fileId"
  | "fileUniqueId"
  | "width"
  | "height"
  | "replyTelegramBackpressured"
  | "stickerFallbackText"
  | "voiceMime"
  | "voiceDurationSeconds"
> {
  context: MessageTriggerContext;
  speaker: AiSpeakerSnapshot;
}

/** 一条媒体记录的完整 Worker 载荷。 */
export function buildAiRecordMediaMessage({
  context,
  speaker,
  kind,
  caption,
  fileId,
  fileUniqueId,
  width,
  height,
  replyTelegramBackpressured,
  stickerFallbackText,
  voiceMime,
  voiceDurationSeconds,
}: BuildAiRecordMediaMessageParams): AiRecordMediaMessage {
  return {
    type: "recordMedia",
    chatId: context.chatId,
    senderId: speaker.id,
    firstName: speaker.firstName,
    lastName: speaker.lastName,
    username: speaker.username,
    messageId: context.message.message_id,
    replyTo: context.replyReference,
    forwardedFrom: context.forwardedFrom,
    persistImmediately: false,
    kind,
    caption,
    fileId,
    fileUniqueId,
    width,
    height,
    replyTelegramBackpressured,
    stickerFallbackText,
    voiceMime,
    voiceDurationSeconds,
    directTriggerReason: context.directTriggerReason,
    // Worker 按入站占位并异步解析媒体；话题落点随载荷保留到该轮实际发送。
    messageThreadId: context.messageThreadId,
  };
}
