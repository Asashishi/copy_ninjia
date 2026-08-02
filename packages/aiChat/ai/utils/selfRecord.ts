import type {
  AiBotInfo,
  AiRecordMessage,
  AiReplyReference,
} from "../../../types/aiChat/protocol";

/**
 * 机器人把自己刚发出的消息写回滚动记忆时的公共载荷。主线程侧（内联结果
 * 自录、洗澡触发的固定回复）与 AI Worker 侧（回复轮里的文字/贴纸/图片自录、
 * 限频提示自录）共六处都要拼同一组字段，散着写过一遍就漂移一次——转录靠
 * `[id:]` 认自己，任一处把 senderId 或 username 写错，模型就会把自己的发言
 * 当成第三个人。
 *
 * 与 auto/message/recordContext.ts 同理，这里返回的是**完整**的 AiRecordMessage
 * 而不是半份上下文：原先各调用点都要 `{...buildSelfRecordContext(...), text}`
 * 展开一次，而对象展开在 JSC 里走的是运行时枚举自有键的通用拷贝，比一次写全的
 * 字面量贵约一个数量级（实测 365.88 → 43.53 ns/op）。
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
