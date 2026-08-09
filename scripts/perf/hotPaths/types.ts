/**
 * 热点基准的公共契约：场景名、场景形状与 JIT 分层读数。
 *
 * 单独成文件是为了打断依赖环——scenarios.ts 要用 Scenario/JitProbe，jitTiers.ts
 * 也要用，而 jitTiers.ts 又被 scenarios.ts 引用来建探针表。
 */

export type ScenarioName =
  | "sender-no-username"
  | "sender-stable-username"
  | "ai-activity-window"
  | "ai-activity-lru-miss"
  | "ad-empty-metadata"
  | "ad-wire-clone"
  | "array-timestamp-window"
  | "float64-timestamp-window"
  | "array-timestamp-cold"
  | "float64-timestamp-cold"
  | "linked-timestamp-window"
  | "linked-rolling-buffer"
  | "bounded-rolling-buffer"
  | "chat-state-read"
  | "self-sent-empty"
  | "incoming-message-spine"
  | "flood-window-hit"
  | "flood-window-churn"
  | "buffered-message-build"
  | "transcript-render"
  | "reply-reference"
  | "mention-facts"
  | "mention-facts-plain"
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
 * 光看最终计数分不清两种截然不同的情况：预热期就编译完、采样期一直跑优化
 * 代码（读数干净），还是采样进行到一半才去优化重编译。因此预热后与采样后
 * 各读一次，只有后者比前者大才说明重编译发生在计时窗口内。
 *
 * **为真不等于读数作废。** 两个 cold 场景实测就是 true：去优化稳定发生在第 3
 * 次采样，之后 4~7 次都跑在重编译后的稳态上。也就是 7 个样本里只有 1 个夹带
 * 重编译成本，排序取中位数正好把它排除。加长预热改变不了这个时点（试过预热
 * 到与采样等量，去优化照样落在第 3 次），因为触发它的是累计分配量而不是预热
 * 不足。因此本字段的用途是**解释离群样本的来源**，不是「该场景必须修」的判据；
 * 真正需要动手的是探针函数自己 reoptRetries>0——那才是生产代码的 shape 不稳。
 */
export interface JitTierStats extends JitTierCounts {
  changedDuringSampling: boolean;
}

export interface Scenario {
  iterations: number;
  /**
   * 跑 iterations 轮并返回校验和。允许返回 Promise：编排层入口本身是 async，
   * 只能连同它的 promise 开销一起量——生产里每条消息付的也正是这份开销。
   * 同步场景仍走同步分支，不会被拖进微任务队列，历史读数因此保持可比。
   */
  run: (iterations: number) => number | Promise<number>;
  reset?: () => void;
  /**
   * 本场景想观测分层的热函数；键名原样进入结果 JSON，便于逐个对照。
   * 不必登记基准循环自身，runBenchmark 会以 `scenario.run` 固定补上。
   */
  probes?: Readonly<Record<string, JitProbe>>;
}

/**
 * 一次堆快照。
 *
 * **`heapStats()` 的计数只在 GC 边界更新**，不是实时的：把 5 万个确定存活的对象
 * 分配出来后立刻读，obj/heap 增量都是 0；同一批对象在 `Bun.gc(true)` 之后再读，
 * 才如实显示 134367 个对象、4601132 字节（Bun 1.3.14 控制组实测）。因此两次快照
 * 之间**必须隔一次 GC**，否则读到的恒为 0，而不是「没有分配」。
 */
