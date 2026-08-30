/**
 * 机器人自发消息回环识别（packages/infra/selfSentTracker.ts）的内存状态。
 *
 * perThread：主线程、AI 闲聊 Worker、Anti-Raid Worker 都会经 infra/telegram 发消息，
 * 各自在本线程登记自己刚发出的那条，互不共享也不需要共享——判回环只看本线程发过什么。
 *
 * 两张表都按 chatId 分层、内层才是 messageId，而不是拼 `chatId:messageId` 复合串：
 * 判回环在每条群消息上最多要跑 5 次（调用点清单见 infra/selfSentTracker.ts 头注），
 * 复合串等于每次现造一个短命字符串，实测比两次整数键查找贵一个量级。分层之后
 * 没发过消息的群在外层就落空，连内层都不必查。
 */

import type { SelfSentWaiter } from "../../types/telegram";

/**
 * 登记中的「机器人自己刚发出的消息」：chatId -> messageId -> TTL timer。
 *
 * 本线程发送成功时写入，SELF_SENT_MESSAGE_TTL_MS 到期由各自的 timer 自删；某群最后
 * 一条到期时内层表一并摘除，因此外层非空恒等于「确实还有在窗记录」。容量等于一个
 * TTL 窗口内本线程发出的消息数，timer 全部 unref，线程重建后从空表开始。
 */
export const sentMessages: Map<number, Map<number, ReturnType<typeof setTimeout>>> = new Map();

/**
 * 尚在等待 Worker `sent` 回执的频道 update：分层与 sentMessages 完全一致。
 *
 * 同一频道帖的原帖与自动转发可各有一个 waiter，因此内层值是 Set；标记到达或超时即
 * 摘除，空的 Set 与空的内层表同步删除。容量只等于最近一个 rendezvous 窗口内尚未
 * 判定的频道 update 数，timer 全部 unref，线程重建后清空。
 */
export const pendingSelfSentWaiters: Map<number, Map<number, Set<SelfSentWaiter>>> = new Map();

/** 在窗自发消息总条数；分层之后 `sentMessages.size` 只是群数，断言与诊断用这个。 */
export function sentMessageCount(): number {
  let count: number = 0;
  for (const byMessage of sentMessages.values()) count += byMessage.size;
  return count;
}

/** 线程停止或测试隔离时取消两张表的全部 timer 并清空；不改变任何持久化状态。 */
export function resetSelfSentTracker(): void {
  for (const byMessage of sentMessages.values()) {
    for (const timer of byMessage.values()) clearTimeout(timer);
  }
  sentMessages.clear();
  for (const byMessage of pendingSelfSentWaiters.values()) {
    for (const waiters of byMessage.values()) {
      for (const waiter of waiters) clearTimeout(waiter.timer);
    }
  }
  pendingSelfSentWaiters.clear();
}
