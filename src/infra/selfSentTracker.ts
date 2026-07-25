import { SELF_SENT_MESSAGE_TTL_MS } from "../consts/telegram";
import { sentMessages } from "../cache/selfSentTracker";

/**
 * 登记「机器人自己刚发出的消息」，供自动流水线（src/auto/message/）识别
 * 出「这条更新其实是自己发的」并整体跳过——普通群消息 Telegram 不会把机器人
 * 自己发的推回来，但机器人在自己管理的频道里发帖时，channel_post 更新会
 * 不区分发帖者原样推回（转发进关联讨论组的副本同理，见 forward_origin 的
 * 用法）；这类回环若被当成新内容处理，会被 AI 随机回复/随机复读/洗澡触发
 * 等自动流水线再次响应，形成自说自话的循环。
 *
 * 本模块只在各自的线程内生效（Worker 各自持有独立的模块实例，见
 * infra/telegram/ 入口注释）：Worker 里发送的消息要让主线程的自动流水线
 * 认出来，得由 Worker 经 postMessage 把 chatId/messageId 报回主线程，主线程
 * 收到后再调用这里的 markSelfSent（见 aiChat/index.ts 的 onEvent）。
 */

function key(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** 登记一条刚发出的消息；TTL 到期自动清理。 */
export function markSelfSent(chatId: number, messageId: number): void {
  const k: string = key(chatId, messageId);
  const existing = sentMessages.get(k);
  if (existing) clearTimeout(existing);
  sentMessages.set(
    k,
    setTimeout(() => sentMessages.delete(k), SELF_SENT_MESSAGE_TTL_MS).unref()
  );
}

/** 某条消息是否是机器人自己刚发出的。 */
export function isSelfSent(chatId: number, messageId: number): boolean {
  return sentMessages.has(key(chatId, messageId));
}
