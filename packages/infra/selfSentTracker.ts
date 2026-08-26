import type { Message, MessageOrigin } from "@grammyjs/types";
import {
  SELF_SENT_MESSAGE_TTL_MS,
  SELF_SENT_RENDEZVOUS_TIMEOUT_MS,
} from "../consts/telegram";
import {
  pendingSelfSentWaiters,
  sentMessages,
} from "../cache/perThread/selfSentTracker";
import type { SelfSentWaiter } from "../types/telegram";

/**
 * 登记「机器人自己刚发出的消息」，供自动流水线（packages/auto/message/）识别
 * 出「这条更新其实是自己发的」并整体跳过——普通群消息 Telegram 不会把机器人
 * 自己发的推回来，但机器人在自己管理的频道里发帖时，channel_post 更新会
 * 不区分发帖者原样推回（转发进关联讨论组的副本同理，见 forward_origin 的
 * 用法）；这类回环若被当成新内容处理，会被 AI 随机回复/随机复读/洗澡触发
 * 等自动流水线再次响应，形成自说自话的循环。
 *
 * 本模块只在各自的线程内生效（Worker 各自持有独立的模块实例，见
 * infra/telegram/ 入口注释）：Worker 里发送的消息要让主线程的自动流水线
 * 认出来，得由 Worker 经 postMessage 把 chatId/messageId 报回主线程，主线程
 * 收到后再调用这里的 markSelfSent（见 aiChat/workerBridge.ts 的 onEvent）。
 */

function key(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** 只有 Telegram 会回投的两种形态需要等待跨线程标记。 */
function rendezvousKey(message: Message): string | undefined {
  if (message.chat.type === "channel") return key(message.chat.id, message.message_id);
  const origin: MessageOrigin | undefined = message.forward_origin;
  if (message.is_automatic_forward === true && origin?.type === "channel") {
    return key(origin.chat.id, origin.message_id);
  }
  return undefined;
}

/**
 * 当前消息是否属于可能跨线程晚到标记的 Telegram 回投形态。
 *
 * 普通群聊和私聊不会回投机器人自己发送的消息，调用方可据此保留同步快速路径；
 * 频道帖及频道自动转发仍必须进入有界 rendezvous，不能只做一次即时查询。
 */
export function needsBotOwnMessageWait(message: Message): boolean {
  if (message.chat.type === "channel") return true;
  return message.is_automatic_forward === true && message.forward_origin?.type === "channel";
}

/** 标记到达时一次唤醒同一原帖的频道帖与关联讨论组副本。 */
function settleSelfSentWaiters(k: string): void {
  const waiters: Set<SelfSentWaiter> | undefined = pendingSelfSentWaiters.get(k);
  if (waiters === undefined) return;
  pendingSelfSentWaiters.delete(k);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

/** 登记一条刚发出的消息；TTL 到期自动清理。 */
export function markSelfSent(chatId: number, messageId: number): void {
  const k: string = key(chatId, messageId);
  const existing: ReturnType<typeof setTimeout> | undefined = sentMessages.get(k);
  if (existing) clearTimeout(existing);
  sentMessages.set(
    k,
    setTimeout((): boolean => sentMessages.delete(k), SELF_SENT_MESSAGE_TTL_MS).unref()
  );
  settleSelfSentWaiters(k);
}

/** 某条消息是否是机器人自己刚发出的。 */
export function isSelfSent(chatId: number, messageId: number): boolean {
  if (sentMessages.size === 0) return false;
  return sentMessages.has(key(chatId, messageId));
}

/**
 * 识别机器人自己发送内容的频道/关联讨论组回弹。任何会对消息产生输出的入口
 * 都必须先过这一关，否则机器人会对自己的帖子作出反应，形成自说自话的循环
 * （见本文件头注）。自动流水线与注册在其前面的 `/<中文字>` 动作命令共用此边界。
 */
export function isBotOwnMessage(message: Message): boolean {
  if (isSelfSent(message.chat.id, message.message_id)) return true;
  const origin: MessageOrigin | undefined = message.forward_origin;
  return message.is_automatic_forward === true &&
    origin?.type === "channel" &&
    isSelfSent(origin.chat.id, origin.message_id);
}

/**
 * 跨线程发送专用门禁：标记已到则立即返回；可能回投的频道消息最多等待一个
 * 有界窗口，期间 `markSelfSent` 会立即唤醒。普通群/私聊不创建 timer。
 */
export function waitForBotOwnMessage(
  message: Message,
  timeoutMs: number = SELF_SENT_RENDEZVOUS_TIMEOUT_MS
): Promise<boolean> {
  if (isBotOwnMessage(message)) return Promise.resolve(true);
  const k: string | undefined = rendezvousKey(message);
  if (k === undefined) return Promise.resolve(false);
  return new Promise((resolve: (matched: boolean) => void): void => {
    let waiters: Set<SelfSentWaiter> | undefined = pendingSelfSentWaiters.get(k);
    if (waiters === undefined) {
      waiters = new Set<SelfSentWaiter>();
      pendingSelfSentWaiters.set(k, waiters);
    }
    const waiter: SelfSentWaiter = {
      resolve,
      timer: setTimeout((): void => {
        const current: Set<SelfSentWaiter> | undefined = pendingSelfSentWaiters.get(k);
        current?.delete(waiter);
        if (current?.size === 0) pendingSelfSentWaiters.delete(k);
        resolve(false);
      }, timeoutMs),
    };
    waiter.timer.unref();
    waiters.add(waiter);
    // 防御未来调用点在登记期间同步触发标记；即使时序改变也不丢唤醒。
    if (sentMessages.has(k)) settleSelfSentWaiters(k);
  });
}
