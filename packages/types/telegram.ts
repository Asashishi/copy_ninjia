/** Telegram 动作适配层与业务调用方共享的发送结果。 */

/**
 * 本项目会发出的 Telegram 聊天状态取值。
 *
 * 单点定义：AI 回复心跳的挡位类型（types/aiChat/chatAction.ts 的
 * ChatActionPhase）由它加上 "idle" 派生，发送侧也直接吃它。两处各写一份联合
 * 类型的话，新增一个状态时漏改任何一处都编译通过，运行时才发现发出去的是
 * 另一个状态。
 */
export type TelegramChatAction = "typing" | "upload_photo" | "choose_sticker";

/** 一条已成功发送的 Telegram 消息；repliedToMessageId 只在服务端实际挂上
 * 回复关系时存在，不能用请求参数推断。 */
export interface TelegramSendResult {
  messageId: number;
  repliedToMessageId?: number;
}
