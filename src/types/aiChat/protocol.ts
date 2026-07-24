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
  /** 原消息是转发时的来源标注（见 auto/message/facts.ts 的 resolveForwardOrigin）。 */
  forwardedFrom?: string;
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
  /** 当前消息本身是转发时的来源标注；非转发省略。 */
  forwardedFrom?: string;
  /**
   * 主线程确认该群此前发生过 durable purge 时，要求这条记录形成的快照
   * 绕过周期上报；仅由 aiChat.ts 注入，Telegram 入口不得自行设置。
   */
  persistImmediately?: boolean;
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

/** /switch_mood 的重抽请求：未过 deadlineAt 时 Worker 调 ai/mood.ts 的
 *  switchMood，再以同 requestId 的 moodSwitched 回执带回结果；过期请求
 *  不得产生副作用，回复由主线程命令处理器发出。 */
export interface AiSwitchMoodMessage {
  type: "switchMood";
  chatId: number;
  /** 主线程分配的单调递增回执关联 id（见 cache/aiChat.ts 的 moodSwitchRequestCounter）。 */
  requestId: number;
  /** 请求的绝对截止时刻；Worker 收到时已过期则不得再改写群心情。 */
  deadlineAt: number;
}

export type AiChatWorkerMessage =
  | AiInitMessage
  | AiRecordMessage
  | AiRecordMediaMessage
  | AiTriggerMessage
  | AiHydrateMessage
  | AiHydrateStickerCatalogMessage
  | AiFlushMemoryMessage
  | AiInvalidateChatMessage
  | AiSwitchMoodMessage;

export interface AiSentMessage {
  type: "sent";
  chatId: number;
  messageId: number;
}

export interface AiMemoryEvent {
  type: "memory";
  chatId: number;
  snapshot: string;
  /** purge 后首份新快照；主线程须要求 Disk I/O 立即写盘并等待 revision 回执。 */
  persistImmediately?: boolean;
}

export interface AiMemoryDeletedEvent {
  type: "memoryDeleted";
  chatId: number;
}

export interface AiMemoryFlushedEvent {
  type: "memoryFlushed";
  flushId: number;
}

/** switchMood 请求的回执：带回重抽结果，主线程凭 requestId 结算等待者。 */
export interface AiMoodSwitchedEvent {
  type: "moodSwitched";
  chatId: number;
  requestId: number;
  /** 新抽中的心情档位名（config/mood.json 的 name 字段）。 */
  moodName: string;
}

export type AiChatWorkerEvent =
  | AiSentMessage
  | AiMemoryEvent
  | AiMemoryDeletedEvent
  | AiMemoryFlushedEvent
  | AiMoodSwitchedEvent
  | AiStickerCatalogEvent;
