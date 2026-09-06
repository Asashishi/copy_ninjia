/**
 * 热点基准的公共契约：场景名、场景形状与 JIT 分层读数。
 *
 * 单独成文件是为了打断依赖环——scenarios.ts 要用 Scenario/JitProbe，jitTiers.ts
 * 也要用，而 jitTiers.ts 又被 scenarios.ts 引用来建探针表。
 */

import type { HotPathProfileScenarioName } from "../../../packages/types/performance";

export type ScenarioName =
  | HotPathProfileScenarioName
  | "storage-sqlite-flush"
  | "wed-member-hit"
  | "wed-member-growth"
  | "wed-member-churn"
  | "wed-member-chat-switch"
  | "registered-middleware"
  | "sender-no-username"
  | "ai-activity-lru-miss"
  | "temporary-whitelist-activity"
  | "ad-empty-metadata"
  | "ad-wire-clone"
  | "quota-timestamp-window"
  | "bounded-rolling-buffer"
  | "chat-state-read"
  | "chat-state-map-read"
  | "self-sent-empty"
  | "self-sent-active"
  | "flood-window-hit"
  | "flood-window-growth"
  | "gag-speak-counter"
  | "buffered-message-build"
  | "transcript-render"
  | "reply-reference"
  | "mention-facts"
  | "redact-clean-log"
  | "luck-tier-table";

/**
 * 可被 bun:jsc 询问 JIT 分层状态的热函数。只用于观测，基准从不调用它。
 * 形参写成 never[] 是为了容纳任意签名的被测函数，同时不引入 any。
 */
export type JitProbe = (...args: never[]) => unknown;

/**
 * 一个热函数在某个时刻的 JSC 分层计数。
 *
 * dfgCompiles=0 表示它从未进入 DFG——要么调用次数不足以触发分层，要么被测
 * 逻辑其实不在这个函数里，两种情况下该场景的 ns/op 都测不到优化后的稳态。
 * reoptRetries>0 是真正的坏味道：JSC 编译后又因为推测失败（类型/对象 shape
 * 不稳定）被迫去优化并重编译，正是 AGENTS.md「热调用点保持类型和对象 shape
 * 稳定」那条规约的机器可判信号。
 */
export interface JitTierCounts {
  dfgCompiles: number;
  reoptRetries: number;
}

/**
 * 分层计数加上「这次重编译落在哪一段」的判定。
 *
 * 预热后与采样后各读取一次计数；后者增加表示重编译发生在计时窗口内。
 */
export interface JitTierStats extends JitTierCounts {
  changedDuringSampling: boolean;
}

export interface Scenario {
  iterations: number;
  /**
   * 跑 iterations 轮并返回校验和。允许返回 Promise：编排层入口本身是 async，
   * 只能连同它的 promise 开销一起量——生产里每条消息付的也正是这份开销。
   * 同步场景保持同步分支，不计入微任务调度开销。
   */
  run: (iterations: number) => number | Promise<number>;
  /** reset 后、预热前建立不计时的场景前置状态。 */
  prepare?: () => void;
  reset?: () => void;
  /** 每个正式样本前重新 reset + prepare；用于只量从空表增长的相变阶段。 */
  resetBeforeSample?: boolean;
  /**
   * 本场景想观测分层的热函数；键名原样进入结果 JSON，便于逐个对照。
   * 不必登记基准循环自身，runBenchmark 会以 `scenario.run` 固定补上。
   */
  probes?: Readonly<Record<string, JitProbe>>;
}

/**
 * 一次堆快照。
 *
 * `heapStats()` 的计数只在 GC 边界更新。两次快照之间必须执行一次诊断 GC，
 * 否则零增量不能代表没有分配。
 */
