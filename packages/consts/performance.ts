import type { HotPathProfileScenarioName } from "../types/performance";

/**
 * 热路径 GC/RSS 门禁校准时使用的 Bun 版本；升级运行时必须重新测量阈值。
 *
 * 9.3.0 把锚点抬到 1.4.0 时阈值还是 1.3.14 的采样，9.3.2 补上了这次重测：本文件
 * 的逐场景 ns/op 软阈值全部按 1.4.0 空载重标，内存上限的引用读数也换成 1.4.0。
 * 下次再升运行时，这两组数同样必须整组重测，不能只改这里的版本号。
 */
export const HOT_PATH_PROFILE_BUN_VERSION: string = "1.4.0";

/** 热路径 GC/RSS 门禁校准时使用的 Bun 构建 revision，防止同版本不同引擎混测。 */
export const HOT_PATH_PROFILE_BUN_REVISION: string =
  "34cbb9a40b4bd1bd767d134a7065e66c2432a676";

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
 * Bun 1.4.0 空载实测（每场景 10 进程，identity-permission-read 20 进程）采样峰值
 * 与生命周期高水位几乎重合，最重的是 flood-window-steady 126.5/126.5 MB，其次
 * ad-capacity-reject 107.4 MB、incoming-message-spine 83.6/85.3 MB、
 * mention-facts-plain 74.1 MB。1.4.0 整体比 1.3.14 省内存（同口径下
 * flood-window-steady 曾是 145.6/146.4 MB、incoming-message-spine 105.1/105.8 MB），
 * 384 MB 对最重的那个因此从约 2.6 倍余量放大到约 3.0 倍。**没有跟着收紧**：这道闸
 * 的职责是拦失控，不是贴着水位跑；把兜底闸调成回归判据只会换来会抖的硬失败。
 *
 * 代价要说明白：最重那个场景**真的翻倍**（145.6 → 291 MB）也不会碰到这道闸。这是
 * 有意的分工，不是失手——CPU 延迟异常由逐场景 ns/op 软上报指出，而这里只负责
 * 拦住「一路涨到把机器吃光」。改这个数之前先想清楚它现在只承担哪一件事，
 * 别再拿「还够得着一次翻倍」当理由继续放宽。
 */
export const HOT_PATH_PROFILE_MAX_RSS_BYTES: number = 384 * 1024 * 1024;

/**
 * 正式采样各节拍观测到的 heapUsed 相对预热基线最大增长。上限覆盖满载 flood LRU
 * 持续换入不同成员时尚未到下一次 GC 的有界对象波峰；Bun 1.4.0 空载重测（同上，
 * 每场景 10 进程）峰值 24.1 MB，仍出在 flood-window-steady，其余场景都在 0.1 MB
 * 以下。1.3.14 同口径是 62.1 MB，96 MB 的余量因此从约 1.5 倍放大到约 4 倍。
 * 与 RSS 上限同理不收紧：GC 何时到来本就不确定，把它压到贴着水位会换来偶发硬失败。
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
 *
 * 当前值来自 Bun 1.4.0（revision 34cbb9a4）空载重标：服务已停、机器无其它负载。
 * 每场景至少 13 个独立 retained 子进程，ai-media-direct-trigger 与 ai-activity-window
 * 各 22 个、identity-permission-read 43 个（这三项尾部方差大，见下）。各场景最慢中位数
 * 按本表声明顺序为 2285.791/193.800/33.655/37.434/76.300/537.271/19.334/150.738/
 * 117.900 ns/op；阈值 = 最慢中位数 + max(25%, 10 ns) 后向上取整，不再额外凑到整五或
 * 整十——凑整会让「这个数怎么来的」无法复算。
 *
 * 进程数逐场景定，理由全部来自实测而非预设。先按 10 个进程定了一版，随后三轮门禁
 * 接连在 spine、flood-window-steady、ai-activity-window、ai-media-direct-trigger 与
 * identity-permission-read 上刷出更慢的读数，余量被吃到 10%~13%。尾部低估是量出来的，
 * 于是样本只加不减：并入门禁自身读数，再给反复越界的 ai-media-direct-trigger、
 * ai-activity-window 各补 10 个进程，给 identity-permission-read 补到 43 个。补完
 * ai-activity-window 的阈值回到 96，与 1.3.14 定的值一致——两次取到了同一条尾部。
 * 再重标时同样只能加样本，别拿一两轮读数就定值。
 *
 * identity-permission-read 仍是本表离散度最大的一项，且**没有**因为换引擎而收敛：
 * 43 个进程实测 82.167~117.900（中位 89.2），跨度约 1.4 倍，与 1.3.14 的 90.0~134.7
 * 同一量级。中途只用 20~23 个进程时它两次被刷穿，正是抽样没覆盖到尾部；这一项的
 * 进程数只能加不能减。
 *
 * 对比 1.3.14 的同口径读数：incoming-message-spine 2024.461 → 2285.791（+12.9%）与
 * ai-media-direct-trigger 164.080 → 193.800（+18.1%）确实变慢；三项变快，
 * ad-capacity-reject 218.306 → 150.738、luck-receipt-fast-path 49.993 → 37.434、
 * identity-permission-read 134.700 → 117.900；其余四项在 ±5% 以内。阈值因此有松有紧：
 * spine 与 ai-media-direct-trigger 放宽（它们在 1.4.0 上真的更慢），
 * luck-receipt-fast-path、ad-capacity-reject、identity-permission-read 收紧——继续留着
 * 1.3.14 的宽度，软报就失去了「出现即异常」的意义。
 *
 * 重标必须在空载机器上跑。1.3.14 时代 ai-media-direct-trigger 是在跑着本仓库服务
 * 进程的机器上校准的，那个数因此偏保守；本次已消除该偏差。
 */
export const HOT_PATH_PROFILE_MEDIAN_NS_PER_OP_REPORT_THRESHOLDS: Readonly<
  Record<HotPathProfileScenarioName, number>
> = {
  "incoming-message-spine": 2_858,
  "ai-media-direct-trigger": 243,
  "sender-stable-username": 44,
  "luck-receipt-fast-path": 48,
  "ai-activity-window": 96,
  "flood-window-steady": 672,
  "mention-facts-plain": 30,
  "ad-capacity-reject": 189,
  "identity-permission-read": 148,
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
