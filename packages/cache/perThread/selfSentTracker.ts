/** owner: perThread。机器人自发消息回环识别（packages/infra/selfSentTracker.ts）的内存状态。
 *
 * 填充方：发消息的主线程在发送成功时登记，Worker 通过主线程请求发送。
 * 各 isolate 不共享此表；入站回环判定读取主线程拥有的发送结果。
 *
 * sentMessages 与 pendingSelfSentWaiters 按 chatId 分层、内层才是 messageId，按两次整数键
 * 查找，不构造复合字符串键；inFlightSelfSends 只按 chatId 计数。判回环在每条群消息上会
 * 多次调用（调用点清单见 infra/selfSentTracker.ts 头注）；没发过消息的群在外层就落空，不查内层。
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
 * 尚在等待发送成功登记的频道 update：分层同 sentMessages。
 *
 * 同一频道帖的原帖与自动转发可各有一个 waiter，因此内层值是 Set；标记到达、超时，或该
 * chat 的在途发送归零时（按 false 结算）即摘除，空的 Set 与空的内层表同步删除。容量只等于最近一个 rendezvous 窗口内尚未
 * 判定的频道 update 数，timer 全部 unref，线程重建后清空。
 */
export const pendingSelfSentWaiters: Map<number, Map<number, Set<SelfSentWaiter>>> = new Map();

/**
 * 本线程尚未结算的产消息出站请求数：chatId -> 在途数。
 *
 * 发出请求前加一，响应落地并完成 `markSelfSent` 的同一同步段内减一，失败同样减一；
 * 归零即删键，外层只保留确有在途发送的 chat。容量等于同时在途的发送目标数；
 * 线程重建后从空表开始（重建前的在途请求随旧线程一并结束）。
 */
export const inFlightSelfSends: Map<number, number> = new Map();

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
  inFlightSelfSends.clear();
}
