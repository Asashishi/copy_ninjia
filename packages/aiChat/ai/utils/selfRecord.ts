import { SELF_SPEAKER_NAME } from "../../../consts/aiChat/prompts/transcript";
import type {
  AiBotInfo,
  AiRecordMessage,
  AiReplyReference,
} from "../../../types/aiChat/protocol";

/**
 * 机器人把自己刚发出的消息写回滚动记忆时的公共载荷。主线程侧与 AI Worker 侧
 * 调用点共用完整 AiRecordMessage 构造；senderId 保留自身 ID，姓名改用统一代称，
 * lastName 为空且 username 显式 undefined。builder 一次写齐固定字段，不创建投影或对象展开。
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
    firstName: SELF_SPEAKER_NAME,
    lastName: "",
    username: undefined,
    messageId,
    replyTo,
    forwardedFrom: undefined,
    persistImmediately: false,
    text,
  };
}
