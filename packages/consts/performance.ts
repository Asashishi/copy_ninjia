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

/** 极短 mention 叶子在 profile 模式下的操作数倍数，确保 1 ms 采样至少覆盖 50 点。 */
export const HOT_PATH_PROFILE_FAST_SCENARIO_ITERATION_MULTIPLIER: number = 4;

/** 稳态采样允许落在 GC 中的最大比例；超过即说明短命分配已经成为可见 CPU 成本。 */
export const HOT_PATH_PROFILE_MAX_GC_PERCENT: number = 5;

/**
 * 稳态采样必须落在 FTL 的最低比例。异步入站主链仍有 native/调度样本，Bun 1.3.14
 * 三轮实测最低 45.7%，因此以 35% 作为能识别高层 JIT 失效且保留噪声余量的闸值。
 */
export const HOT_PATH_PROFILE_MIN_FTL_PERCENT: number = 35;

/** 单个热路径独立进程允许达到的 RSS 峰值，覆盖 JSC 与 Bun 原生堆。 */
export const HOT_PATH_PROFILE_MAX_RSS_BYTES: number = 256 * 1024 * 1024;

/**
 * 正式采样各节拍观测到的 heapUsed 相对预热基线最大增长。上限覆盖满载 flood LRU
 * 持续换入不同成员时尚未到下一次 GC 的有界对象波峰；Bun 1.3.14 三次独立进程
 * 实测峰值 62.1 MB，据此保留约 1.5 倍余量。
 */
export const HOT_PATH_PROFILE_MAX_SAMPLED_HEAP_GROWTH_BYTES: number =
  96 * 1024 * 1024;

/**
 * 默认性能门禁覆盖的真实消息主链及三个高频叶子热点；元素顺序固定，独立进程
 * 按此顺序串行运行，避免并发争抢 CPU/内存污染读数。
 */
export const HOT_PATH_PROFILE_SCENARIOS: readonly string[] = [
  "incoming-message-spine",
  "ai-activity-window",
  "flood-window-steady",
  "mention-facts-plain",
];
