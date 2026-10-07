/**
 * 热点基准的公共契约：场景名、场景形状与 JIT 分层读数。
 * 各领域场景文件与 jitTiers.ts 共用。
 */

import type { HotPathProfileScenarioName } from "../../../packages/types/performance";

export type ScenarioName =
  | HotPathProfileScenarioName
  | "cooldown-hit"
  | "cooldown-renew"
  | "cooldown-growth"
  | "cooldown-saturated"
  | "cooldown-expiry"
  | "reply-admission"
  | "reply-delivery-normal"
  | "reply-delivery-capacity"
  | "base64-normal"
  | "base64-large"
  | "base64-head"
  | "base64-tail"
  | "voice-message-encode"
  | "proxy-tts-detect"
  | "storage-sqlite-flush"
  | "verification-snapshot"
  | "verification-snapshot-clone"
  | "bounded-response-empty"
  | "bounded-response-tiny"
  | "bounded-response-small"
  | "bounded-response-normal"
  | "bounded-response-large"
  | "wed-member-hit"
  | "wed-member-growth"
  | "wed-member-churn"
  | "wed-member-chat-switch"
  | "registered-middleware"
  | "sender-no-username"
  | "sender-mixed-identity"
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
 * 可被 bun:jsc 询问 JIT 分层状态的热函数，只用于观测，不被基准调用。
 * 形参为 `never[]`，容纳任意签名。
 */
export type JitProbe = (...args: never[]) => unknown;

/**
 * 一个热函数在某个时刻的 JSC 分层计数。
 *
 * dfgCompiles 为 0 表示从未进入 DFG（调用次数不足以触发分层，或被测逻辑不在该
 * 函数里），该场景的 ns/op 不含优化后的稳态。reoptRetries 大于 0 表示 JSC 编译后
 * 因推测失败（类型或对象 shape 不稳定）去优化并重编译，对应 AGENTS.md「热调用点
 * 保持类型和对象 shape 稳定」的规约。
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
  /** 异步或 I/O 场景可显式指定完整操作的预热次数；缺省沿用热点默认值。 */
  warmupIterations?: number;
  /** 完整 I/O 操作可只观察实际 JIT 层级；缺省要求生产探针进入 DFG 并稳定。 */
  profileRequiresOptimizedJit?: boolean;
  /**
   * 跑 iterations 轮并返回校验和。允许返回 Promise：异步场景连同 promise 开销一起量；
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
   * 不必登记基准循环自身，collectJitTiers 会以 `scenario.run` 固定补上。
   */
  probes?: Readonly<Record<string, JitProbe>>;
}
