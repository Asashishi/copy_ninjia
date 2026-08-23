import type { HotPathProfileScenarioName } from "../types/performance";

/**
 * 热路径 GC/RSS 门禁的**采样旋钮**，以及门禁覆盖的固定场景表。
 *
 * 这里只放与测量结果无关的常量：换一台机器、换一个 Bun 构建，下面这些数字都
 * 不需要动。随运行时重测而变的那一半——Bun 版本与 revision、GC/RSS/常驻增长
 * 硬上限、逐场景 ns/op 软阈值，以及每个数字背后的实测读数——是**校准记录**
 * 而不是代码常量，全部放在仓库根被跟踪的 `performance-result.json`，由
 * `scripts/perf/hotPaths/gateResult.ts` 严格解析。重标时改那份 JSON，不改本文件。
 */

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
  "mention-facts-plain",
  "ad-capacity-reject",
  "identity-permission-read",
];
