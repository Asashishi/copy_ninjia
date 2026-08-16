/**
 * 各热点场景共用的基准夹具：固定的群 id、时间戳起点与一份最小消息。
 *
 * 单独成文件是因为它们跨场景组共用（scenarios.ts、messageSpineScenarios.ts、
 * floodScenarios.ts、transcriptScenarios.ts），而各组按领域分文件之后，
 * 谁都不该为了拿一个常量去 import 另一组场景。
 */

import type { Message } from "@grammyjs/types";

/** 基准群聊 id；仅用于进程内 Map，不产生任何 Telegram 或磁盘副作用。 */
export const BENCHMARK_CHAT_ID: number = -100_000_000_000_001;
/**
 * 所有时间戳场景的起点，取 2026-01-01T00:00:00Z 的毫秒值。
 *
 * 必须用生产量级，不能用 1_000_000 这类小整数。`Date.now()` 的毫秒值约 1.75e12，
 * 早已超出 int32；生产里这些窗口喂进来的全是 `Date.now()`，基准喂小整数就等于
 * 在量一份生产永远遇不到的输入。换成本常量后多个场景的读数明显移位
 * （linked-timestamp-window 46.8 → 74.1、linked-rolling-buffer 75.2 → 107.9
 * ns/op），说明旧读数确实建立在不具代表性的输入上。
 *
 * 需要澄清一点，免得后来者据此得出过强的结论：**单纯的大数值本身并不会让
 * JSC 反复去优化**——全程只喂 `Date.now()` 量级时，`observeGroupMessageForAiReply`
 * 稳定是 dfg=1/reopt=0。真正触发去优化的是**同一进程内先喂小整数、后喂大浮点**
 * 那次量级切换（实测 reopt 从 0 涨到 2）。对生产的启示不是「别用大时间戳」，而是
 * 同一个热函数不要在不同调用点喂进量级/类型不同的数值。
 *
 * 用固定常量而不是 `Date.now()`，是为了让各次运行的输入完全可复现。
 */
export const BENCHMARK_EPOCH_MS: number = 1_767_225_600_000;

export function messageFixture(username?: string): Message {
  return {
    message_id: 1,
    date: 1,
    chat: {
      id: BENCHMARK_CHAT_ID,
      type: "supergroup",
      title: "Performance fixture",
    },
    from: {
      id: 42,
      is_bot: false,
      first_name: "Stable",
      last_name: "Sender",
      username,
    },
  };
}
