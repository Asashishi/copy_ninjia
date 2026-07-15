/** Worker 侧自我认知所需的机器人账号身份（bot.init() 之后才可得，见 initAiChat）。 */
export interface AiBotInfo {
  id: number;
  username: string;
  first_name: string;
}

/** 主线程 -> Worker：注入机器人账号身份（必须先于一切 trigger 送达）。 */
export interface AiInitMessage {
  type: "init";
  botInfo: AiBotInfo;
}

/** 主线程 -> Worker：把一条群消息记入该群的滚动对话缓存。 */
export interface AiRecordMessage {
  type: "record";
  chatId: number;
  senderId: number;
  firstName: string;
  lastName: string;
  text: string;
}

/** 主线程 -> Worker：触发一次 AI 回复（冷却/限频判定也在 Worker 侧做）。 */
export interface AiTriggerMessage {
  type: "trigger";
  chatId: number;
  replyToMessageId: number;
  repliedBotText?: string;
  isRandomTrigger: boolean;
}

export type AiChatWorkerMessage = AiInitMessage | AiRecordMessage | AiTriggerMessage;

/**
 * Worker -> 主线程：一条消息已经发出去了（AI 回复或跟发的贴纸）。Worker
 * 用的是自己线程内独立的 grammY Api 客户端，主线程的自动流水线认不出
 * 那次发送——报回来让主线程登记进 infra/selfSentTracker.ts，识别出「频道
 * 自回环」并整体跳过，不然会被自己的随机回复再触发一轮（见 auto/message.ts）。
 */
export interface AiSentMessage {
  type: "sent";
  chatId: number;
  messageId: number;
}

export type AiChatWorkerEvent = AiSentMessage;
