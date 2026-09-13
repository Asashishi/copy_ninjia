import type { HotPathGcCpuBudget, HotPathProfileScenarioName } from "../types/performance";

/** GC 暂停日志测量窗口的起始标记；仅性能脚本向 stderr 输出。 */
export const HOT_PATH_GC_WINDOW_START: string = "COPY_NINJIA_GC_WINDOW_START";

/** GC 暂停日志测量窗口的结束标记，后接单调时钟测得的毫秒数。 */
export const HOT_PATH_GC_WINDOW_END: string = "COPY_NINJIA_GC_WINDOW_END";

/**
 * 热路径门禁的采样参数、固定场景和 CPU 分档 GC 标准。
 * Bun 构建、内存硬上限、逐场景延迟阈值与实测数据保存在
 * `performance-result.json`，由 `scripts/perf/hotPaths/gateResult.ts` 严格解析。
 */

/** 热路径 GC 暂停占比按可用 CPU 数分档；下界降序，首个匹配项适用于所有场景。 */
export const HOT_PATH_GC_CPU_BUDGETS: readonly HotPathGcCpuBudget[] = [
  { minCpuCount: 4, maxPausePercent: 25 },
  { minCpuCount: 2, maxPausePercent: 30 },
  { minCpuCount: 1, maxPausePercent: 35 },
];

/** 热路径稳态采样的 JSC profiler 间隔；1 ms 与 Bun CPU profiler 默认粒度对齐。 */
export const HOT_PATH_PROFILE_SAMPLE_INTERVAL_US: number = 1_000;

/** 每个固定热路径在独立进程中重复的次数，用来排除单次调度与 JIT 偶然性。 */
export const HOT_PATH_PROFILE_REPEATS: number = 3;

/** 正式采样前要求生产 JIT 探针连续保持不变的完整场景轮数。 */
export const HOT_PATH_PROFILE_REQUIRED_STABLE_JIT_ROUNDS: number = 2;

/** JIT 稳定预热的最大完整场景轮数；超过仍变化就拒绝给出稳态读数。 */
export const HOT_PATH_PROFILE_MAX_JIT_STABILIZATION_ROUNDS: number = 6;

/** 读取进程内存时仅对系统调用中断进行的最大尝试次数，耗尽后保留原错误失败。 */
export const HOT_PATH_PROFILE_MEMORY_USAGE_MAX_ATTEMPTS: number = 3;

/**
 * 极短 mention 叶子在 profile 模式下的操作数倍数，确保 1 ms 采样至少覆盖
 * `performance-result.json` 里 `limits.minProfileSamples` 要求的样本点。
 */
export const HOT_PATH_PROFILE_FAST_SCENARIO_ITERATION_MULTIPLIER: number = 4;

/**
 * 默认性能门禁覆盖真实消息主链与固定高频叶子热点；元素顺序固定，独立进程按此
 * 顺序串行运行，避免并发争抢 CPU/内存污染读数。
 *
 * 这张表是场景**构成**、不是读数，因此留在代码里；它与 `performance-result.json` 的
 * `calibration.scenarios` 必须精确一一对应，由
 * `assertHotPathMedianPolicyCoverage` 在门禁启动时双向核对。
 */
export const HOT_PATH_PROFILE_SCENARIOS: readonly HotPathProfileScenarioName[] = [
  "incoming-message-spine",
  "ai-media-direct-trigger",
  "sender-stable-username",
  "luck-receipt-fast-path",
  "ai-activity-window",
  "flood-window-steady",
  "join-timestamp-window",
  "mention-facts-plain",
  "ad-capacity-reject",
  "identity-permission-read",
];
