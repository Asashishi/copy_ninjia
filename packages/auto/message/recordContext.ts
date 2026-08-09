import type {
  AiRecordMediaMessage,
  AiRecordMessage,
} from "../../types/aiChat/protocol";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import type { MessageTriggerContext } from "../../types/auto";
import type { MediaKind } from "../../types/media";

/**
 * 文字与各媒体 handler 共用的 Worker 记录载荷构造边界，集中保持身份和回复
 * 关系一致。
 *
 * **这里刻意不再返回「公共字段的一半」让调用点 `...` 展开。** 曾经是那样写的
 * （buildAiRecordContext + 调用点展开 + recordChatMessage 里再补一次
 * `{type, ...}`），一条消息为此造三个对象、拷两遍属性。对象展开在 JSC 里是按
 * 运行时枚举自有键的通用拷贝，拿不到定形分配的快路径：实测同一份载荷，
 * 「定形 builder + 一次展开」365.88 ns/op，一次写全的字面量 43.53 ns/op；
 * 连同条件展开一起算，旧写法 495.75 ns/op，新写法 52.10 ns/op。公共字段的
 * 唯一真相仍在本文件，但产出的是**完整**消息，中间不再有半成品。
 *
 * options 形参不带来额外分配：调用点那个字面量不逃逸，JSC 会把它整体消掉
 * （实测 options 11.35 ns/op vs 位置参数 11.78 ns/op，差异在噪声内），因此
 * 沿用项目「超过 3 个参数走 options interface」的既定写法没有性能代价。
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

/** 媒体记录里逐载荷不同的那部分；身份与回复关系仍由本文件统一填。 */
export interface AiRecordMediaPayload {
  kind: MediaKind;
  caption: string;
  fileId: string;
  fileUniqueId: string;
  /** 视觉素材的像素尺寸；语音传 0。 */
  width: number;
  height: number;
  commentOnResolve: boolean;
  imageGenerationRequested: boolean;
  /** 仅贴纸使用；其余媒体传 undefined。 */
  stickerFallbackText: string | undefined;
  /** 仅语音使用：Telegram 声明的容器；其余媒体传 undefined。 */
  voiceMime: string | undefined;
  /** 仅语音使用：时长（秒）；其余媒体传 0。 */
  voiceDurationSeconds: number;
}

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
    imageGenerationRequested: media.imageGenerationRequested,
    stickerFallbackText: media.stickerFallbackText,
    voiceMime: media.voiceMime,
    voiceDurationSeconds: media.voiceDurationSeconds,
    directTrigger: context.directTrigger,
  };
}
