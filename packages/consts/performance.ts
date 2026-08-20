import type { HotPathProfileScenarioName } from "../types/performance";

/** 热路径 GC/RSS 门禁校准时使用的 Bun 版本；升级运行时必须重新测量阈值。 */
export const HOT_PATH_PROFILE_BUN_VERSION: string = "1.3.14";

/** 热路径 GC/RSS 门禁校准时使用的 Bun 构建 revision，防止同版本不同引擎混测。 */
export const HOT_PATH_PROFILE_BUN_REVISION: string =
  "0d9b296af33f2b851fcbf4df3e9ec89751734ba4";

/** 热路径稳态采样的 JSC profiler 间隔；1 ms 与 Bun CPU profiler 默认粒度对齐。 */
export const HOT_PATH_PROFILE_SAMPLE_INTERVAL_US: number = 1_000;

/** 每个固定热路径在独立进程中重复的次数，用来排除单次调度与 JIT 偶然性。 */
export const HOT_PATH_PROFILE_REPEATS: number = 3;

/** 正式采样前要求生产 JIT 探针连续保持不变的完整场景轮数。 */
export const HOT_PATH_PROFILE_REQUIRED_STABLE_JIT_ROUNDS: number = 2;

/** JIT 稳定预热的最大完整场景轮数；超过仍变化就拒绝给出稳态读数。 */
export const HOT_PATH_PROFILE_MAX_JIT_STABILIZATION_ROUNDS: number = 6;

/** 单次稳态 profile 至少需要的样本数；不足时 GC 百分比没有判别力。 */
export const HOT_PATH_PROFILE_MIN_SAMPLES: number = 50;

/** 读取进程内存时仅对系统调用中断进行的最大尝试次数，耗尽后保留原错误失败。 */
export const HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS: number = 3;

/** 极短 mention 叶子在 profile 模式下的操作数倍数，确保 1 ms 采样至少覆盖 50 点。 */
export const HOT_PATH_PROFILE_FAST_SCENARIO_ITERATION_MULTIPLIER: number = 4;

/** 稳态采样允许落在 GC 中的最大比例；超过即说明短命分配已经成为可见 CPU 成本。 */
export const HOT_PATH_PROFILE_MAX_GC_PERCENT: number = 5;

/**
 * retained 子进程的 RSS 上限，覆盖 JSC 与 Bun 原生堆。逐节拍采样峰值与进程生命周期
 * 高水位（getrusage maxRSS）共用这一个阈值：只掐采样峰值的话，完整落在两次节拍之间
 * 的大块瞬时分配会被漏掉，而那正是这条门禁要拦的东西。
 *
 * **这是失控兜底，不是回归判据，更不是机器内存预算**：场景子进程一次只起一个（见
 * scripts/perf/hotPathProfileGate.ts 的串行 for 循环），硬失败仍由 GC、JIT 与 full-GC
 * 后全局留存上限判定；逐场景延迟只做软上报，避免把确实耗时的合法操作误判失败。
 *
 * Bun 1.3.14 实测采样峰值与生命周期高水位几乎重合，最重的是
 * flood-window-steady 145.6/146.4 MB，其次 incoming-message-spine 105.1/105.8 MB、
 * luck-receipt-fast-path 96.3 MB、mention-facts-plain 73.6 MB。384 MB 对最重的那个
 * 保留约 2.6 倍余量，取的是「负载高的 CI 机器上单次读数抖动也不会误报」。
 *
 * 代价要说明白：最重那个场景**真的翻倍**（145.6 → 291 MB）也不会碰到这道闸。这是
 * 有意的分工，不是失手——CPU 延迟异常由逐场景 ns/op 软上报指出，而这里只负责
 * 拦住「一路涨到把机器吃光」。改这个数之前先想清楚它现在只承担哪一件事，
 * 别再拿「还够得着一次翻倍」当理由继续放宽。
 */
export const HOT_PATH_PROFILE_MAX_RSS_BYTES: number = 384 * 1024 * 1024;

/**
 * 正式采样各节拍观测到的 heapUsed 相对预热基线最大增长。上限覆盖满载 flood LRU
 * 持续换入不同成员时尚未到下一次 GC 的有界对象波峰；Bun 1.3.14 三次独立进程
 * 实测峰值 62.1 MB，据此保留约 1.5 倍余量。
 */
export const HOT_PATH_PROFILE_MAX_SAMPLED_HEAP_GROWTH_BYTES: number =
  96 * 1024 * 1024;

/** retained 场景在 full GC 后允许留下的 JSC 堆增量。 */
export const HOT_PATH_PROFILE_MAX_RETAINED_HEAP_GROWTH_BYTES: number =
  1 * 1024 * 1024;

/** retained 场景在 full GC 后允许留下的 JSC 堆外内存增量。 */
export const HOT_PATH_PROFILE_MAX_RETAINED_EXTRA_MEMORY_GROWTH_BYTES: number =
  1 * 1024 * 1024;

/** retained 场景在 full GC 后允许留下的对象数增量。 */
export const HOT_PATH_PROFILE_MAX_RETAINED_OBJECT_GROWTH: number = 4_096;

/**
 * 每个默认热场景在 retained 独立进程中的中位纳秒/操作软上报阈值。
 * 超过只输出场景与超额读数，不让门禁失败；数值只能在固定 Bun revision、
 * 固定输入并经多个独立进程重测后调整。
 * Bun 1.3.14 每场景 10 进程的最慢中位数为 2024.461/33.027/49.993/76.583/
 * 521.289/18.550/218.306/134.700 ns/op；上限在其上增加 max(25%, 10 ns) 并向上取整。
 *
 * 上面那串八个数按本表**前八项原有的声明顺序**给出，不含后加的
 * ai-media-direct-trigger；那一项 10 进程最慢中位数 164.080 ns/op，按同一规则取 210。
 * 它的校准跑在一台同时运行着本仓库服务进程的机器上（那份负载当时无法移除），
 * 因此这个数偏保守——重新校准时若机器空载，读数会更低，可以按同一规则收紧。
 *
 * identity-permission-read 的那个数取自 20 个独立进程加门禁自己的 repeat：它是本表
 * 里离散度最大的一项（90.0~134.7），只按前 10 个进程定阈值会让它每隔几次门禁就软
 * 报一次，而软报的价值全在「出现即异常」。
 */
export const HOT_PATH_PROFILE_MEDIAN_NS_PER_OP_REPORT_THRESHOLDS: Readonly<
  Record<HotPathProfileScenarioName, number>
> = {
  "incoming-message-spine": 2_550,
  "ai-media-direct-trigger": 210,
  "sender-stable-username": 44,
  "luck-receipt-fast-path": 63,
  "ai-activity-window": 96,
  "flood-window-steady": 655,
  "mention-facts-plain": 29,
  "ad-capacity-reject": 275,
  "identity-permission-read": 169,
};

/**
 * 默认性能门禁覆盖真实消息主链与固定高频叶子热点；元素顺序固定，独立进程按此
 * 顺序串行运行，避免并发争抢 CPU/内存污染读数。
 */
export const HOT_PATH_PROFILE_SCENARIOS: readonly HotPathProfileScenarioName[] = [
  "incoming-message-spine",
  "ai-media-direct-trigger",
  "sender-stable-username",
  "luck-receipt-fast-path",
  "ai-activity-window",
  "flood-window-steady",
  "mention-facts-plain",
  "ad-capacity-reject",
  "identity-permission-read",
];
