import type { Message, MessageOrigin } from "grammy/types";
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
 * 各线程持有独立实例。Worker 的发送请求由主线程 workerRequests.ts 执行，
 * 成功后在主线程登记 markSelfSent，再向 Worker 返回回执。
 * @see ../../docs/cn/04-invariants.md
 *
 * **isBotOwnMessage 是每条群消息都要走的判定，且一条消息会走多次**：
 * antiRaid/temporaryWhitelist.ts、antiRaid/adCandidate.ts、commands/qa/ingress.ts、
 * commands/cjkAction.ts、auto/message/index.ts 各查一次，自动转发那条还会查第二次。
 * 这里按 (chatId, messageId) 两级整数键直查。
 */

/** TTL 到期：摘掉这一条，并在该群最后一条消失时把内层表一并删除。 */
function forgetSelfSent(chatId: number, messageId: number): void {
  const byMessage: Map<number, ReturnType<typeof setTimeout>> | undefined =
    sentMessages.get(chatId);
  if (byMessage === undefined) return;
  byMessage.delete(messageId);
  if (byMessage.size === 0) sentMessages.delete(chatId);
}

/** 标记到达时一次唤醒同一原帖的频道帖与关联讨论组副本。 */
function settleSelfSentWaiters(chatId: number, messageId: number): void {
  const byMessage: Map<number, Set<SelfSentWaiter>> | undefined =
    pendingSelfSentWaiters.get(chatId);
  if (byMessage === undefined) return;
  const waiters: Set<SelfSentWaiter> | undefined = byMessage.get(messageId);
  if (waiters === undefined) return;
  byMessage.delete(messageId);
  if (byMessage.size === 0) pendingSelfSentWaiters.delete(chatId);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }
}

/** 超时或结算后摘掉自己那一个 waiter，空 Set 与空内层表同步删除。 */
function removeSelfSentWaiter(
  chatId: number,
  messageId: number,
  waiter: SelfSentWaiter
): void {
  const byMessage: Map<number, Set<SelfSentWaiter>> | undefined =
    pendingSelfSentWaiters.get(chatId);
  if (byMessage === undefined) return;
  const waiters: Set<SelfSentWaiter> | undefined = byMessage.get(messageId);
  if (waiters === undefined) return;
  waiters.delete(waiter);
  if (waiters.size > 0) return;
  byMessage.delete(messageId);
  if (byMessage.size === 0) pendingSelfSentWaiters.delete(chatId);
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

/** 登记一条刚发出的消息；TTL 到期自动清理。 */
export function markSelfSent(chatId: number, messageId: number): void {
  let byMessage: Map<number, ReturnType<typeof setTimeout>> | undefined =
    sentMessages.get(chatId);
  if (byMessage === undefined) {
    byMessage = new Map<number, ReturnType<typeof setTimeout>>();
    sentMessages.set(chatId, byMessage);
  }
  const existing: ReturnType<typeof setTimeout> | undefined = byMessage.get(messageId);
  if (existing !== undefined) clearTimeout(existing);
  byMessage.set(
    messageId,
    setTimeout(
      (): void => forgetSelfSent(chatId, messageId),
      SELF_SENT_MESSAGE_TTL_MS
    ).unref()
  );
  settleSelfSentWaiters(chatId, messageId);
}

/** 某条消息是否是机器人自己刚发出的。 */
export function isSelfSent(chatId: number, messageId: number): boolean {
  // 本线程一条都没发过时连内层表都不必取；活跃线程则只多付一次整数键查找。
  if (sentMessages.size === 0) return false;
  return sentMessages.get(chatId)?.has(messageId) === true;
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
  // rendezvous 目标与 needsBotOwnMessageWait 判定的两种形态一一对应：频道帖等自己，
  // 关联讨论组的自动转发等它的频道原帖。其余形态 Telegram 不会回投，不建等待项。
  let chatId: number;
  let messageId: number;
  if (message.chat.type === "channel") {
    chatId = message.chat.id;
    messageId = message.message_id;
  } else {
    const origin: MessageOrigin | undefined = message.forward_origin;
    if (
      message.is_automatic_forward !== true ||
      origin?.type !== "channel"
    ) return Promise.resolve(false);
    chatId = origin.chat.id;
    messageId = origin.message_id;
  }
  return new Promise((resolve: (matched: boolean) => void): void => {
    let byMessage: Map<number, Set<SelfSentWaiter>> | undefined =
      pendingSelfSentWaiters.get(chatId);
    if (byMessage === undefined) {
      byMessage = new Map<number, Set<SelfSentWaiter>>();
      pendingSelfSentWaiters.set(chatId, byMessage);
    }
    let waiters: Set<SelfSentWaiter> | undefined = byMessage.get(messageId);
    if (waiters === undefined) {
      waiters = new Set<SelfSentWaiter>();
      byMessage.set(messageId, waiters);
    }
    const waiter: SelfSentWaiter = {
      resolve,
      timer: setTimeout((): void => {
        removeSelfSentWaiter(chatId, messageId, waiter);
        resolve(false);
      }, timeoutMs),
    };
    waiter.timer.unref();
    waiters.add(waiter);
    // 防御未来调用点在登记期间同步触发标记；即使时序改变也不丢唤醒。
    if (isSelfSent(chatId, messageId)) settleSelfSentWaiters(chatId, messageId);
  });
}
