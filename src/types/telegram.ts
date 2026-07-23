/** Telegram 动作适配层与业务调用方共享的发送结果。 */

/** 一条已成功发送的 Telegram 消息；repliedToMessageId 只在服务端实际挂上
 * 回复关系时存在，不能用请求参数推断。 */
export interface TelegramSendResult {
  messageId: number;
  repliedToMessageId?: number;
}
