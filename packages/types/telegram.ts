/** Telegram 动作适配层与业务调用方共享的发送结果。 */

import type { TelegramApi } from "./telegramWorker";

/**
 * 本项目会发出的 Telegram 聊天状态取值。
 *
 * 单点定义：AI 回复心跳的挡位类型（types/aiChat/chatAction.ts 的
 * ChatActionPhase）由它加上 "idle" 派生，发送侧也直接吃它。两处各写一份联合
 * 类型的话，新增一个状态时漏改任何一处都编译通过，运行时才发现发出去的是
 * 另一个状态。
 */
export type TelegramChatAction = "typing" | "upload_photo" | "choose_sticker" | "upload_document";

/** 一条已成功发送的 Telegram 消息；repliedToMessageId 只在服务端实际挂上
 * 回复关系时存在，不能用请求参数推断。 */
export interface TelegramSendResult {
  messageId: number;
  repliedToMessageId?: number;
}

/** 等待跨线程自发消息标记的单个主线程 rendezvous。 */
export interface SelfSentWaiter {
  readonly resolve: (matched: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 延迟删除只需要单条与批量删除能力，真实客户端和 Worker 代理均可实现。 */
export type TelegramMessageDeletionApi = Pick<
  TelegramApi,
  "deleteMessage" | "deleteMessages"
>;

/** 主线程/Worker 各自登记的一条延迟删除任务。 */
export interface PendingMessageDeletion {
  readonly chatId: number;
  readonly messageId: number;
  readonly api: TelegramMessageDeletionApi;
  /** 停机提前兑现时是否允许与同客户端、同群条目合成 deleteMessages。 */
  readonly batchOnFlush: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 机器人自己在某个群里持有的、决定「破坏性动作做不做得成」的管理员权限位。
 *
 * 「是管理员」与「能踢人/能删消息」是两回事：被授予管理员却没勾对应开关是
 * 最常见的失败成因，而 Telegram 对这类拒绝只回一句 400 `not enough rights`，
 * 事后看日志分不清是权限问题还是别的。因此主线程按群缓存这份权限位，在真正
 * 发请求之前就地判定（见 packages/infra/botAdmin.ts 与 packages/cache/main/botAdmin.ts）。
 * 只收「对别人动手」需要的那几项——改群资料、置顶这类与本项目行为无关的开关
 * 不进来，多存一项就多一处要跟着 Telegram 维护的事实。
 */
export interface BotChatPermissions {
  /** 能否限制成员（禁言、私密模式收发言权、封禁）。群主恒为真。 */
  canRestrictMembers: boolean;
  /** 能否删除别人的消息。群主恒为真。 */
  canDeleteMessages: boolean;
}
