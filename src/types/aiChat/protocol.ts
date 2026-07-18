import type { MediaKind } from "../media";
import type { AiHydrateStickerCatalogMessage, AiStickerCatalogEvent } from "../stickers/protocol";

/** Worker 侧自我认知所需的机器人账号身份。 */
export interface AiBotInfo {
  id: number;
  username: string;
  first_name: string;
}

export interface AiInitMessage {
  type: "init";
  botInfo: AiBotInfo;
}

export interface AiRecordMessage {
  type: "record";
  chatId: number;
  senderId: number;
  firstName: string;
  lastName: string;
  username?: string;
  text: string;
}

export interface AiRecordMediaMessage {
  type: "recordMedia";
  kind: MediaKind;
  chatId: number;
  senderId: number;
  firstName: string;
  lastName: string;
  username?: string;
  caption: string;
  fileId: string;
  fileUniqueId: string;
  messageId: number;
  commentOnResolve: boolean;
  stickerFallbackText?: string;
  directTrigger?: {
    reason: "reply" | "mention";
    repliedBotText?: string;
  };
}

export interface AiTriggerMessage {
  type: "trigger";
  chatId: number;
  replyToMessageId: number;
  repliedBotText?: string;
  isRandomTrigger: boolean;
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
