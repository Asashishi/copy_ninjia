import type { MediaKind, TelegramVisionSource } from "../media";
import type { AiHydrateStickerCatalogMessage, AiStickerCatalogEvent } from "../stickers/protocol";
import type { AiSpeakerSnapshot } from "./speaker";

/** Worker 侧自我认知所需的机器人账号身份。 */
export interface AiBotInfo {
  id: number;
  username: string;
  first_name: string;
}

/** 本轮生图可选的一张 Telegram 参考图；只在触发/排队链路短期流转，不落盘。 */
export type ImageGenerationReference = TelegramVisionSource;
export type AiDirectTriggerReason = "reply" | "mention";

export interface AiInitMessage {
  type: "init";
  botInfo: AiBotInfo;
}

/** 主线程从 Telegram update 提取的原始回复引用；Worker 会清洗成持久化形态。 */
export interface AiReplyReference extends AiSpeakerSnapshot {
  messageId: number;
  text: string;
  quote?: string;
}

/** 文字与媒体记录协议共用的消息身份和回复关系。 */
export interface AiRecordContext {
  chatId: number;
  senderId: number;
  firstName: string;
  lastName: string;
  username?: string;
  messageId: number;
  replyTo?: AiReplyReference;
}

export interface AiRecordMessage extends AiRecordContext {
  type: "record";
  text: string;
}

export interface AiRecordMediaMessage extends AiRecordContext {
  type: "recordMedia";
  kind: MediaKind;
  caption: string;
  fileId: string;
  fileUniqueId: string;
  /** 实际传给视觉管线的本体/缩略图尺寸。 */
  width: number;
  height: number;
  commentOnResolve: boolean;
  /** 当前媒体消息是否直接回复/@机器人，允许模型自行判断图片工具意图。 */
  imageGenerationRequested: boolean;
  stickerFallbackText?: string;
  directTrigger?: {
    reason: AiDirectTriggerReason;
  };
}

export interface AiTriggerMessage {
  type: "trigger";
  chatId: number;
  triggerSenderId: number;
  replyToMessageId: number;
  isRandomTrigger: boolean;
  /** 当前触发是否具备图片工具资格；具体生成/编辑意图由模型判断。 */
  imageGenerationRequested: boolean;
  /** 当前图片/贴纸，或本条文字回复的图片/贴纸；仅在直接触发的本轮短期附带。 */
  imageGenerationReference?: ImageGenerationReference;
}

export interface AiHydrateMessage {
  type: "hydrate";
  memories: Map<number, string>;
}

export interface AiFlushMemoryMessage {
  type: "flushMemory";
  flushId: number;
}

export interface AiInvalidateChatMessage {
  type: "invalidateChat";
  chatId: number;
  purgeMemory: boolean;
}

export type AiChatWorkerMessage =
  | AiInitMessage
  | AiRecordMessage
  | AiRecordMediaMessage
  | AiTriggerMessage
  | AiHydrateMessage
  | AiHydrateStickerCatalogMessage
  | AiFlushMemoryMessage
  | AiInvalidateChatMessage;

export interface AiSentMessage {
  type: "sent";
  chatId: number;
  messageId: number;
}

export interface AiMemoryEvent {
  type: "memory";
  chatId: number;
  snapshot: string;
}

export interface AiMemoryDeletedEvent {
  type: "memoryDeleted";
  chatId: number;
}

export interface AiMemoryFlushedEvent {
  type: "memoryFlushed";
  flushId: number;
}

export type AiChatWorkerEvent =
  | AiSentMessage
  | AiMemoryEvent
  | AiMemoryDeletedEvent
  | AiMemoryFlushedEvent
  | AiStickerCatalogEvent;
