/**
 * 机器人自发消息回环识别（packages/infra/selfSentTracker.ts）的内存状态。
 *
 * perThread：发消息的主线程在发送成功时登记，Worker 通过主线程请求发送。
 * 各 isolate 不共享此表；入站回环判定读取主线程拥有的发送结果。
 *
 * 两张表都按 chatId 分层、内层才是 messageId，按两次整数键查找，不构造复合字符串键。
 * 判回环在每条群消息上最多要跑 5 次（调用点清单见 infra/selfSentTracker.ts 头注）；
 * 没发过消息的群在外层就落空，不查内层。
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
 * 尚在等待发送成功登记的频道 update：分层与 sentMessages 完全一致。
 *
 * 同一频道帖的原帖与自动转发可各有一个 waiter，因此内层值是 Set；标记到达或超时即
 * 摘除，空的 Set 与空的内层表同步删除。容量只等于最近一个 rendezvous 窗口内尚未
 * 判定的频道 update 数，timer 全部 unref，线程重建后清空。
 */
export const pendingSelfSentWaiters: Map<number, Map<number, Set<SelfSentWaiter>>> = new Map();

/** 重置时以 false 结算等待者并取消全部 timer；不改变任何持久化状态。 */
export function resetSelfSentTracker(): void {
  for (const byMessage of sentMessages.values()) {
    for (const timer of byMessage.values()) clearTimeout(timer);
  }
  sentMessages.clear();
  for (const byMessage of pendingSelfSentWaiters.values()) {
    for (const waiters of byMessage.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(false);
      }
    }
  }
  pendingSelfSentWaiters.clear();
}
