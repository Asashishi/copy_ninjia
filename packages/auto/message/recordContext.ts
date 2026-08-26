import type {
  AiRecordMediaMessage,
  AiRecordMessage,
} from "../../types/aiChat/protocol";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { MessageTriggerContext } from "../../types/auto";

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
 * 媒体记录里逐载荷不同的那部分；身份与回复关系仍由本文件统一填。
 *
 * 从协议类型 `Pick` 派生，协议字段变化会让四个调用点在编译期同步收敛。各字段
 * 的语义（语音传 0、仅贴纸用等）由协议侧 JSDoc 统一声明。
 */
export type AiRecordMediaPayload = Pick<
  AiRecordMediaMessage,
  | "kind"
  | "caption"
  | "fileId"
  | "fileUniqueId"
  | "width"
  | "height"
  | "commentOnResolve"
  | "stickerFallbackText"
  | "voiceMime"
  | "voiceDurationSeconds"
>;

export interface BuildAiRecordMediaMessageParams {
  context: MessageTriggerContext;
  speaker: AiSpeakerSnapshot;
  media: AiRecordMediaPayload;
}

/** 一条媒体记录的完整 Worker 载荷。 */
export function buildAiRecordMediaMessage({
  context,
  speaker,
  media,
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
    kind: media.kind,
    caption: media.caption,
    fileId: media.fileId,
    fileUniqueId: media.fileUniqueId,
    width: media.width,
    height: media.height,
    commentOnResolve: media.commentOnResolve,
    stickerFallbackText: media.stickerFallbackText,
    voiceMime: media.voiceMime,
    voiceDurationSeconds: media.voiceDurationSeconds,
    directTriggerReason: context.directTriggerReason,
    // 媒体轮的回复在 Worker 侧异步发起（describeMedia 解析完才触发），那时手上
    // 只剩这条载荷；话题落点必须随载荷一起过去。
    messageThreadId: context.messageThreadId,
  };
}
