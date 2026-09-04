import type {
  AiBotInfo,
  AiRecordMessage,
  AiReplyReference,
} from "../../../types/aiChat/protocol";

/**
 * 机器人把自己刚发出的消息写回滚动记忆时的公共载荷。主线程侧与 AI Worker 侧
 * 的四个调用点共用同一份完整 AiRecordMessage 构造；转录依赖 `[id:]` 识别自己，
 * senderId 与 username 必须统一。builder 一次写齐固定字段，不创建投影或对象展开。
 *
 * lastName 固定空串：机器人账号只有 first_name，Telegram 不提供姓氏。
 * 自录不参与 purge 后的即时上报，persistImmediately 恒为 false——但这个键必须
 * 写出来，缺了它这条自录就和普通记录不是同一个隐藏类。
 */
export interface SelfRecordMessageParams {
  chatId: number;
  /** 机器人自己的账号身份，来源见 cache/workers/aiChat/identity.ts 的 botInfoState。 */
  self: AiBotInfo;
  /** 刚发出的那条消息的 message_id。 */
  messageId: number;
  /** 这条自录的正文。 */
  text: string;
  /** Telegram 实际建立的回复关系；没挂回复时传 undefined。 */
  replyTo?: AiReplyReference | undefined;
}

export function buildSelfRecordMessage({
  chatId,
  self,
  messageId,
  text,
  replyTo,
}: SelfRecordMessageParams): AiRecordMessage {
  return {
    type: "record",
    chatId,
    senderId: self.id,
    firstName: self.first_name,
    lastName: "",
    username: self.username,
    messageId,
    replyTo,
    forwardedFrom: undefined,
    persistImmediately: false,
    text,
  };
}
