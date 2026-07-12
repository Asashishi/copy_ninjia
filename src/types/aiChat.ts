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
