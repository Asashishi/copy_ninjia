import {
  memoryUsage as jscMemoryUsage,
  profile,
} from "bun:jsc";
import {
  aiReplyActivityByChat,
  aiReplyActivitySweepState,
} from "../../packages/cache/main/auto";
import { clearAiReplyActivity } from "../../packages/auto/message/aiReplyActivity";
import { snapshotHeap } from "./heapSnapshot";
import { installOutboundGuards } from "./outboundGuard";
import { median } from "./statistics";
import { collectJitTiers, diffJitTiers } from "./hotPaths/jitTiers";
import { readInterruptibleMemory, readProcessMemoryUsage } from "./hotPaths/liveMemory";
import { createScenario } from "./hotPaths/scenarios";
import type { HeapSnapshot } from "./heapSnapshot";
import type { JitTierCounts, JitTierStats, Scenario, ScenarioName } from "./hotPaths/types";
import {
  HOT_PATH_PROFILE_FAST_SCENARIO_ITERATION_MULTIPLIER,
  HOT_PATH_PROFILE_MAX_JIT_STABILIZATION_ROUNDS,
  HOT_PATH_PROFILE_REQUIRED_STABLE_JIT_ROUNDS,
  HOT_PATH_PROFILE_SAMPLE_INTERVAL_US,
} from "../../packages/consts/performance";
import {
  summarizeHotPathSamplingProfile,
} from "./hotPaths/profileSummary";
import type {
  HotPathSamplingProfileSummary,
  HotPathSamplingProfileText,
} from "./hotPaths/profileSummary";

installOutboundGuards();

interface LiveMemorySnapshot {
  heapUsed: number;
  rss: number;
  processPeakRssBytes: number;
}

interface BenchmarkResult {
  scenario: ScenarioName;
  measurementMode: "retained" | "steadyProfile";
  bunVersion: string;
  bunRevision: string;
  iterations: number;
  warmupIterations: number;
  samplesNsPerOp: number[];
  medianNsPerOp: number;
  /**
   * 采样期间**留存下来**的堆增量（采样前后各做一次 full GC 再读）。
   *
   * 这里只有 retained 一组，没有「GC 前」的对应项：`heapStats()` 的计数在 GC
   * 边界才更新，采样后不 GC 直接读恒为 0（见 HeapSnapshot），那组数曾经存在过，
   * 但它衡量不了任何东西，留着只会被误读成「这条路径不分配」。
   *
   * 也要清楚它**不度量分配速率**：采样中被回收的短命对象一律不计。短命分配
   * 的运行时后果由 steadyProfile 模式的 GC 采样占比、heapUsed 与 RSS 节拍峰值
   * 共同观测；仍不能把这些读数误称为精确 allocation bytes/op。
   */
  retainedHeapDelta: number | null;
  retainedExtraMemoryDelta: number | null;
  retainedObjectDelta: number | null;
  sampledHeapUsedEndDelta: number;
  peakSampledHeapUsedDelta: number;
  sampledRssEndDelta: number;
  /** 正式循环各节拍观测到的当前 RSS 绝对峰值。 */
  peakSampledRssBytes: number;
  peakSampledRssDelta: number;
  /** getrusage/JSC 的生命周期高水位；可能包含 exec 前启动峰值，只作诊断。 */
  processPeakRssBytes: number;
  samplingProfile: HotPathSamplingProfileSummary | null;
  /** 采样结束时各热函数的 JSC 分层状态；键与 Scenario.probes 一致。 */
  jit: Record<string, JitTierStats>;
  /** 预热结束时的原始 JSC 分层计数。 */
  jitAfterWarmup: Record<string, JitTierCounts>;
  /** 正式采样结束时的原始 JSC 分层计数。 */
  jitAfterSampling: Record<string, JitTierCounts>;
  checksum: number;
}

/** 单场景计时采样数；中位数用于抵抗偶发调度和 GC 抖动。 */
const SAMPLE_COUNT: number = 7;
/** 正式采样前的预热占比，确保热点有机会进入 JSC 高层级编译。 */
const WARMUP_DIVISOR: number = 5;

/** 读取器提到模块级：本函数按样本调用，闭包现造会把分配算进被测的堆增长。 */
function readJscMemoryUsage(): ReturnType<typeof jscMemoryUsage> {
  return jscMemoryUsage();
}

/** 同上；单位是 KiB，换算留给调用方。 */
function readProcessPeakRssKb(): number {
  return process.resourceUsage().maxRSS;
}

function snapshotLiveMemory(): LiveMemorySnapshot {
  // 三次读取都要包：只护住其中一次的话，另外两次照样能被同一个信号打断，
  // 而它们抛出来的效果与第一次完全一样——整轮 profile 白跑。
  const processMemory: NodeJS.MemoryUsage = readProcessMemoryUsage();
  const jscMemory: ReturnType<typeof jscMemoryUsage> =
    readInterruptibleMemory(readJscMemoryUsage);
  const resourcePeakRssBytes: number =
    readInterruptibleMemory(readProcessPeakRssKb) * 1024;
  return {
    heapUsed: processMemory.heapUsed,
    rss: processMemory.rss,
    processPeakRssBytes: Math.max(
      resourcePeakRssBytes,
      jscMemory.peak,
      processMemory.rss
    ),
  };
}

/**
 * async 编排壳可能永远不进 DFG，因此只检查场景显式登记的生产探针。一次稳定
 * 表示所有探针已经进入 DFG，且完整场景轮次前后的编译与重试计数都没有变化。
 */
function productionJitTiersAreStable(
  before: Readonly<Record<string, JitTierCounts>>,
  after: Readonly<Record<string, JitTierCounts>>
): boolean {
  let observedProductionProbe: boolean = false;
  for (const [name, sampled] of Object.entries(after)) {
    if (name === "scenario.run") continue;
    observedProductionProbe = true;
    const warmed: JitTierCounts | undefined = before[name];
    if (
      warmed === undefined ||
      sampled.dfgCompiles < 1 ||
      sampled.dfgCompiles !== warmed.dfgCompiles ||
      sampled.reoptRetries !== warmed.reoptRetries
    ) return false;
  }
  return observedProductionProbe;
}

function parseScenarioName(value: string | undefined): ScenarioName {
  switch (value) {
    case "sender-no-username":
    case "sender-stable-username":
    case "luck-receipt-fast-path":
    case "ai-activity-window":
    case "ai-activity-lru-miss":
    case "ad-empty-metadata":
    case "ad-wire-clone":
    case "ad-capacity-reject":
    case "identity-permission-read":
    case "linked-timestamp-window":
    case "bounded-rolling-buffer":
    case "chat-state-read":
    case "chat-state-map-read":
    case "self-sent-empty":
    case "incoming-message-spine":
    case "ai-media-direct-trigger":
    case "flood-window-hit":
    case "flood-window-growth":
    case "flood-window-steady":
    case "gag-speak-counter":
    case "buffered-message-build":
    case "transcript-render":
    case "reply-reference":
    case "mention-facts":
    case "mention-facts-plain":
    case "redact-clean-log":
    case "luck-tier-table":
      return value;
    default:
      throw new Error(
        "Usage: bun run perf:hot-paths -- " +
        "<sender-no-username|sender-stable-username|luck-receipt-fast-path|" +
        "ai-activity-window|ai-activity-lru-miss|ad-empty-metadata|" +
        "ad-wire-clone|ad-capacity-reject|identity-permission-read|" +
        "linked-timestamp-window|bounded-rolling-buffer|" +
        "chat-state-read|chat-state-map-read|self-sent-empty|incoming-message-spine|" +
        "ai-media-direct-trigger|" +
        "flood-window-hit|flood-window-growth|flood-window-steady|" +
        "gag-speak-counter|" +
        "buffered-message-build|transcript-render|reply-reference|" +
        "mention-facts|mention-facts-plain|redact-clean-log|luck-tier-table>"
      );
  }
}

/**
 * 跑一轮并收敛成数字。同步场景在这里就地返回，绝不进微任务队列——否则每个
 * 既有场景都要多付一次 await，历史读数不再可比；只有真正返回 Promise 的
 * 编排层场景才走 await 分支。
 */
async function runOnce(scenario: Scenario, iterations: number): Promise<number> {
  const result: number | Promise<number> = scenario.run(iterations);
  return typeof result === "number" ? result : await result;
}

async function runBenchmark(
  name: ScenarioName,
  steadyProfile: boolean
): Promise<BenchmarkResult> {
  const scenario: Scenario = createScenario(name);
  let warmupIterations: number = Math.max(
    10_000,
    Math.floor(scenario.iterations / WARMUP_DIVISOR)
  );
  const sampleIterations: number = steadyProfile &&
    name === "mention-facts-plain"
    ? scenario.iterations * HOT_PATH_PROFILE_FAST_SCENARIO_ITERATION_MULTIPLIER
    : scenario.iterations;
  scenario.reset?.();
  scenario.prepare?.();
  let checksum: number = await runOnce(scenario, warmupIterations);
  let tiersAfterWarmup: Record<string, JitTierCounts> = collectJitTiers(scenario);
  if (steadyProfile) {
    let stableRounds: number = 0;
    for (
      let round: number = 0;
      round < HOT_PATH_PROFILE_MAX_JIT_STABILIZATION_ROUNDS;
      round += 1
    ) {
      checksum += await runOnce(scenario, scenario.iterations);
      warmupIterations += scenario.iterations;
      const nextTiers: Record<string, JitTierCounts> = collectJitTiers(scenario);
      if (productionJitTiersAreStable(tiersAfterWarmup, nextTiers)) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }
      tiersAfterWarmup = nextTiers;
      if (stableRounds >= HOT_PATH_PROFILE_REQUIRED_STABLE_JIT_ROUNDS) break;
    }
    if (stableRounds < HOT_PATH_PROFILE_REQUIRED_STABLE_JIT_ROUNDS) {
      throw new Error(
        `${name}: production JIT probes did not stabilize before formal sampling.`
      );
    }
  }
  let before: HeapSnapshot | null = null;
  if (!steadyProfile) {
    Bun.gc(true);
    before = snapshotHeap();
  }
  const liveBefore: LiveMemorySnapshot = snapshotLiveMemory();
  let peakSampledHeapUsed: number = liveBefore.heapUsed;
  let peakSampledRss: number = liveBefore.rss;
  let processPeakRssBytes: number = liveBefore.processPeakRssBytes;
  const samplesNsPerOp: number[] = [];

  async function sampleScenario(): Promise<void> {
    for (let sample: number = 0; sample < SAMPLE_COUNT; sample += 1) {
      if (scenario.resetBeforeSample === true) {
        scenario.reset?.();
        scenario.prepare?.();
      }
      const startedAt: number = Bun.nanoseconds();
      checksum += await runOnce(scenario, sampleIterations);
      samplesNsPerOp.push(
        (Bun.nanoseconds() - startedAt) / sampleIterations
      );
      const memory: LiveMemorySnapshot = snapshotLiveMemory();
      peakSampledHeapUsed = Math.max(peakSampledHeapUsed, memory.heapUsed);
      peakSampledRss = Math.max(peakSampledRss, memory.rss);
      processPeakRssBytes = Math.max(
        processPeakRssBytes,
        memory.processPeakRssBytes
      );
    }
  }

  let samplingProfile: HotPathSamplingProfileSummary | null = null;
  if (steadyProfile) {
    const sampled: HotPathSamplingProfileText = await profile(
      async (): Promise<void> => sampleScenario(),
      HOT_PATH_PROFILE_SAMPLE_INTERVAL_US
    );
    samplingProfile = summarizeHotPathSamplingProfile(sampled);
  } else {
    await sampleScenario();
  }
  const tiersAfterSampling: Record<string, JitTierCounts> =
    collectJitTiers(scenario);
  const jit: Record<string, JitTierStats> =
    diffJitTiers(tiersAfterWarmup, tiersAfterSampling);
  let retained: HeapSnapshot | null = null;
  if (!steadyProfile) {
    Bun.gc(true);
    retained = snapshotHeap();
  }
  const liveAfter: LiveMemorySnapshot = snapshotLiveMemory();
  processPeakRssBytes = Math.max(
    processPeakRssBytes,
    liveAfter.processPeakRssBytes
  );
  scenario.reset?.();

  return {
    scenario: name,
    measurementMode: steadyProfile ? "steadyProfile" : "retained",
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    iterations: sampleIterations,
    warmupIterations,
    samplesNsPerOp,
    medianNsPerOp: median(samplesNsPerOp),
    retainedHeapDelta: retained === null || before === null
      ? null
      : retained.heapSize - before.heapSize,
    retainedExtraMemoryDelta: retained === null || before === null
      ? null
      : retained.extraMemorySize - before.extraMemorySize,
    retainedObjectDelta: retained === null || before === null
      ? null
      : retained.objectCount - before.objectCount,
    sampledHeapUsedEndDelta: liveAfter.heapUsed - liveBefore.heapUsed,
    peakSampledHeapUsedDelta: Math.max(
      0,
      peakSampledHeapUsed - liveBefore.heapUsed
    ),
    sampledRssEndDelta: liveAfter.rss - liveBefore.rss,
    peakSampledRssBytes: peakSampledRss,
    peakSampledRssDelta: Math.max(0, peakSampledRss - liveBefore.rss),
    processPeakRssBytes,
    samplingProfile,
    jit,
    jitAfterWarmup: tiersAfterWarmup,
    jitAfterSampling: tiersAfterSampling,
    checksum,
  };
}

const scenarioName: ScenarioName = parseScenarioName(process.argv[2]);
const mode: string | undefined = process.argv[3];
if (mode !== undefined && mode !== "--profile") {
  throw new Error("Usage: bun scripts/perf/hotPaths.ts <scenario> [--profile]");
}
const result: BenchmarkResult = await runBenchmark(
  scenarioName,
  mode === "--profile"
);
process.stdout.write(`${JSON.stringify(result)}\n`);

if (aiReplyActivitySweepState.timer !== null || aiReplyActivityByChat.size > 0) {
  clearAiReplyActivity();
}
