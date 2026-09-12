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
import { createScenario } from "./hotPaths/scenarioRegistry";
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
   * 边界才更新，采样后不 GC 直接读恒为 0（见 HeapSnapshot），不能用来衡量分配。
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
    case "reply-admission":
    case "reply-delivery-normal":
    case "reply-delivery-capacity":
    case "base64-normal":
    case "base64-large":
    case "base64-head":
    case "base64-tail":
    case "storage-sqlite-flush":
    case "verification-snapshot":
    case "verification-snapshot-clone":
    case "bounded-response-empty":
    case "bounded-response-tiny":
    case "bounded-response-small":
    case "bounded-response-normal":
    case "bounded-response-large":
    case "wed-member-hit":
    case "wed-member-growth":
    case "wed-member-churn":
    case "wed-member-chat-switch":
    case "registered-middleware":
    case "sender-no-username":
    case "sender-stable-username":
    case "sender-mixed-identity":
    case "luck-receipt-fast-path":
    case "ai-activity-window":
    case "ai-activity-lru-miss":
    case "ad-empty-metadata":
    case "ad-wire-clone":
    case "ad-capacity-reject":
    case "identity-permission-read":
    case "temporary-whitelist-activity":
    case "join-timestamp-window":
    case "quota-timestamp-window":
    case "bounded-rolling-buffer":
    case "chat-state-read":
    case "chat-state-map-read":
    case "self-sent-empty":
    case "self-sent-active":
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
        "<verification-snapshot|verification-snapshot-clone|" +
        "reply-admission|reply-delivery-normal|reply-delivery-capacity|base64-normal|base64-large|base64-head|base64-tail|" +
        "bounded-response-empty|bounded-response-tiny|bounded-response-small|bounded-response-normal|bounded-response-large|" +
        "sender-no-username|sender-stable-username|sender-mixed-identity|" +
        "luck-receipt-fast-path|" +
        "ai-activity-window|ai-activity-lru-miss|ad-empty-metadata|" +
        "ad-wire-clone|ad-capacity-reject|identity-permission-read|" +
        "temporary-whitelist-activity|" +
        "join-timestamp-window|quota-timestamp-window|bounded-rolling-buffer|" +
        "chat-state-read|chat-state-map-read|self-sent-empty|incoming-message-spine|" +
        "wed-member-hit|wed-member-growth|wed-member-churn|wed-member-chat-switch|registered-middleware|storage-sqlite-flush|" +
        "ai-media-direct-trigger|" +
        "flood-window-hit|flood-window-growth|flood-window-steady|" +
        "gag-speak-counter|" +
        "buffered-message-build|transcript-render|reply-reference|" +
        "mention-facts|mention-facts-plain|redact-clean-log|luck-tier-table>"
      );
  }
}

/**
 * 跑一轮并收敛成数字。同步场景就地返回；只有异步场景进入 Promise 调度。
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
  let warmupIterations: number = scenario.warmupIterations ?? Math.max(
    10_000,
    Math.floor(scenario.iterations / WARMUP_DIVISOR)
  );
  if (!Number.isSafeInteger(warmupIterations) || warmupIterations < 1) {
    throw new Error(`${name}: warmup iterations must be a positive safe integer.`);
  }
  const sampleIterations: number = steadyProfile &&
    name === "mention-facts-plain"
    ? scenario.iterations * HOT_PATH_PROFILE_FAST_SCENARIO_ITERATION_MULTIPLIER
    : scenario.iterations;
  scenario.reset?.();
  scenario.prepare?.();
  const warmupResult: number | Promise<number> = scenario.run(warmupIterations);
  /**
   * 本场景是不是同步的。由第一次预热的返回值判定，供下面挑采样驱动。
   *
   * `Scenario.run` 的同步/异步是场景自己的固定属性（同一个闭包，分支不随迭代
   * 次数变），因此判定一次即可，正式采样不再重复探测。
   */
  const scenarioIsSynchronous: boolean = typeof warmupResult === "number";
  let checksum: number = typeof warmupResult === "number"
    ? warmupResult
    : await warmupResult;
  let tiersAfterWarmup: Record<string, JitTierCounts> = collectJitTiers(scenario);
  if (steadyProfile && scenario.profileRequiresOptimizedJit !== false) {
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

  /** 一个样本的计时起点；`resetBeforeSample` 的相变准备不计入本样本耗时。 */
  function beginSample(): number {
    if (scenario.resetBeforeSample === true) {
      scenario.reset?.();
      scenario.prepare?.();
    }
    return Bun.nanoseconds();
  }

  /** 收下一个样本的耗时与本节拍的内存水位；两种驱动共用同一套记账。 */
  function endSample(startedAt: number, result: number): void {
    checksum += result;
    samplesNsPerOp.push((Bun.nanoseconds() - startedAt) / sampleIterations);
    const memory: LiveMemorySnapshot = snapshotLiveMemory();
    peakSampledHeapUsed = Math.max(peakSampledHeapUsed, memory.heapUsed);
    peakSampledRss = Math.max(peakSampledRss, memory.rss);
    processPeakRssBytes = Math.max(
      processPeakRssBytes,
      memory.processPeakRssBytes
    );
  }

  /**
   * 同步场景的采样驱动。
   *
   * **分层统计按栈顶帧归属，因此 profile 的回调里不能出现只跑几次的 async 壳。**
   * 那种壳永远进不了 DFG/FTL，用它驱动同步场景时本该记在生产帧上的样本会整段
   * 落到壳自己身上，把「热路径 99% FTL」报成「99% LLInt」——同一份代码换成同步
   * 驱动即为 99% FTL，两者逐样本耗时一致，可见差的只是归属而不是速度。
   * 同步场景一律走本函数，异步场景没有这个选择，其分层读数只作参考。
   */
  function sampleScenarioSync(): void {
    for (let sample: number = 0; sample < SAMPLE_COUNT; sample += 1) {
      const startedAt: number = beginSample();
      const result: number | Promise<number> = scenario.run(sampleIterations);
      if (typeof result !== "number") {
        throw new Error(
          `${name}: the synchronous sampling driver received an asynchronous scenario result.`
        );
      }
      endSample(startedAt, result);
    }
  }

  /** 异步场景的采样驱动；编排壳的开销本来就是生产每条消息要付的那一份。 */
  async function sampleScenarioAsync(): Promise<void> {
    for (let sample: number = 0; sample < SAMPLE_COUNT; sample += 1) {
      const startedAt: number = beginSample();
      endSample(startedAt, await runOnce(scenario, sampleIterations));
    }
  }

  let samplingProfile: HotPathSamplingProfileSummary | null = null;
  if (steadyProfile) {
    const sampled: HotPathSamplingProfileText = scenarioIsSynchronous
      ? profile(sampleScenarioSync, HOT_PATH_PROFILE_SAMPLE_INTERVAL_US)
      : await profile(
        async (): Promise<void> => sampleScenarioAsync(),
        HOT_PATH_PROFILE_SAMPLE_INTERVAL_US
      );
    samplingProfile = summarizeHotPathSamplingProfile(sampled);
  } else if (scenarioIsSynchronous) {
    sampleScenarioSync();
  } else {
    await sampleScenarioAsync();
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

const scenarioName: ScenarioName = parseScenarioName(Bun.argv[2]);
const mode: string | undefined = Bun.argv[3];
if (mode !== undefined && mode !== "--profile") {
  throw new Error("Usage: bun scripts/perf/hotPaths.ts <scenario> [--profile]");
}
const result: BenchmarkResult = await runBenchmark(
  scenarioName,
  mode === "--profile"
);
await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);

if (aiReplyActivitySweepState.timer !== null || aiReplyActivityByChat.size > 0) {
  clearAiReplyActivity();
}
