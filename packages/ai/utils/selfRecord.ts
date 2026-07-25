import type { AiBotInfo, AiRecordContext, AiReplyReference } from "../../types/aiChat/protocol";

/**
 * 机器人把自己刚发出的消息写回滚动记忆时的公共身份字段。主线程侧（内联结果
 * 自录、洗澡触发的固定回复）与 AI Worker 侧（回复轮里的文字/贴纸/图片自录、
 * 限频提示自录）共六处都要拼同一组字段，散着写过一遍就漂移一次——转录靠
 * `[id:]` 认自己，任一处把 senderId 或 username 写错，模型就会把自己的发言
 * 当成第三个人。
 *
 * lastName 固定空串：机器人账号只有 first_name，Telegram 不提供姓氏。
 */
export interface SelfRecordContextParams {
  chatId: number;
  /** 机器人自己的账号身份，来源见 cache/aiChat/identity.ts 的 botInfoState。 */
  self: AiBotInfo;
  /** 刚发出的那条消息的 message_id。 */
  messageId: number;
  /** Telegram 实际建立的回复关系；没挂回复时省略。 */
  replyTo?: AiReplyReference;
}

export function buildSelfRecordContext({
  chatId,
  self,
  messageId,
  replyTo,
}: SelfRecordContextParams): AiRecordContext {
  return {
    chatId,
    senderId: self.id,
    firstName: self.first_name,
    lastName: "",
    username: self.username,
    messageId,
    ...(replyTo ? { replyTo } : {}),
  };
}
