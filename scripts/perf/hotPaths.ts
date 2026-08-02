import { heapStats } from "bun:jsc";
import {
  aiReplyActivityByChat,
  aiReplyActivitySweepState,
} from "../../packages/cache/main/auto";
import { clearAiReplyActivity } from "../../packages/auto/message/aiReplyActivity";
import { bot, joinVerificationApi } from "../../packages/infra/telegram";
import type { Transformer } from "grammy";
import { collectJitTiers, diffJitTiers } from "./hotPaths/jitTiers";
import { createScenario } from "./hotPaths/scenarios";
import type { JitTierCounts, JitTierStats, Scenario, ScenarioName } from "./hotPaths/types";

/**
 * 出站硬闸：本脚本会 import 生产模块，而部署机上 bot 通常正在运行、用的是同一个
 * token。任何一次真实出站都以线上机器人的身份发出，且无法撤回。所有场景按设计
 * 都只碰进程内存，这里把两条出站通道都堵死，让越界变成一次响亮的失败。
 *
 * **必须装 grammY transformer，光换 globalThis.fetch 拦不住它。** grammY 在模块
 * 加载时就把 fetch 绑到内部 shim 上（`node_modules/grammy/out/core/client.js` 里
 * 的 `shim_node_js_1.fetch`），之后调用只认那个绑定；而静态 import 又先于模块体
 * 执行，赋值再早也来不及。实测靠改 globalThis.fetch「保护」的一次基准，仍然向
 * Telegram 发出了三万多次 getChatAdministrators。transformer 挂在 grammY 自己的
 * 调用层，与传输实现无关，才是可靠的拦截点。
 *
 * globalThis.fetch 这道仍然保留，但它覆盖的是**另一类**调用：项目里直接写
 * `fetch(...)` 的地方（头像抓取、JSON API）在调用时才解析全局，因此拦得住。
 */
function installOutboundGuards(): void {
  const deny: Transformer = (_prev: unknown, method: string): never => {
    throw new Error(`perf benchmark attempted Telegram API call '${method}'; scenarios must stay in-process`);
  };
  bot.api.config.use(deny);
  joinVerificationApi.config.use(deny);
  globalThis.fetch = ((...args: unknown[]): never => {
    throw new Error(
      `perf benchmark attempted a network call (${JSON.stringify(args[0])}); scenarios must stay in-process`
    );
  }) as unknown as typeof fetch;
}
installOutboundGuards();

interface HeapSnapshot {
  heapSize: number;
  extraMemorySize: number;
  objectCount: number;
}

interface BenchmarkResult {
  scenario: ScenarioName;
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
   * 也要清楚它**不度量分配速率**：采样中被回收的短命对象一律不计。要量某个
   * 构造器每次调用的分配足迹，得改用「保留结果 + 两侧 GC」的口径，那是另一种
   * 测法，不属于这个吞吐基准。
   */
  retainedHeapDelta: number;
  retainedExtraMemoryDelta: number;
  retainedObjectDelta: number;
  /** 采样结束时各热函数的 JSC 分层状态；键与 Scenario.probes 一致。 */
  jit: Record<string, JitTierStats>;
  checksum: number;
}

/** 单场景计时采样数；中位数用于抵抗偶发调度和 GC 抖动。 */
const SAMPLE_COUNT: number = 7;
/** 正式采样前的预热占比，确保热点有机会进入 JSC 高层级编译。 */
const WARMUP_DIVISOR: number = 5;

function snapshotHeap(): HeapSnapshot {
  const stats: ReturnType<typeof heapStats> = heapStats();
  return {
    heapSize: stats.heapSize,
    extraMemorySize: stats.extraMemorySize,
    objectCount: stats.objectCount,
  };
}

function median(values: readonly number[]): number {
  const sorted: number[] = [...values].sort((left: number, right: number): number => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function parseScenarioName(value: string | undefined): ScenarioName {
  switch (value) {
    case "sender-no-username":
    case "sender-stable-username":
    case "ai-activity-window":
    case "ai-activity-lru-miss":
    case "ad-empty-metadata":
    case "ad-wire-clone":
    case "array-timestamp-window":
    case "float64-timestamp-window":
    case "array-timestamp-cold":
    case "float64-timestamp-cold":
    case "linked-timestamp-window":
    case "linked-rolling-buffer":
    case "bounded-rolling-buffer":
    case "self-sent-empty":
    case "incoming-message-spine":
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
        "<sender-no-username|sender-stable-username|ai-activity-window|ad-empty-metadata|" +
        "ai-activity-lru-miss|" +
        "ad-wire-clone|array-timestamp-window|float64-timestamp-window|" +
        "array-timestamp-cold|float64-timestamp-cold|" +
        "linked-timestamp-window|linked-rolling-buffer|" +
        "bounded-rolling-buffer|self-sent-empty|incoming-message-spine|" +
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

async function runBenchmark(name: ScenarioName): Promise<BenchmarkResult> {
  const scenario: Scenario = createScenario(name);
  const warmupIterations: number = Math.max(
    10_000,
    Math.floor(scenario.iterations / WARMUP_DIVISOR)
  );
  scenario.reset?.();
  let checksum: number = await runOnce(scenario, warmupIterations);
  const tiersAfterWarmup: Record<string, JitTierCounts> = collectJitTiers(scenario);
  Bun.gc(true);
  const before: HeapSnapshot = snapshotHeap();
  const samplesNsPerOp: number[] = [];
  for (let sample: number = 0; sample < SAMPLE_COUNT; sample += 1) {
    const startedAt: number = Bun.nanoseconds();
    checksum += await runOnce(scenario, scenario.iterations);
    samplesNsPerOp.push(
      (Bun.nanoseconds() - startedAt) / scenario.iterations
    );
  }
  const jit: Record<string, JitTierStats> =
    diffJitTiers(tiersAfterWarmup, collectJitTiers(scenario));
  Bun.gc(true);
  const retained: HeapSnapshot = snapshotHeap();
  scenario.reset?.();

  return {
    scenario: name,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    iterations: scenario.iterations,
    warmupIterations,
    samplesNsPerOp,
    medianNsPerOp: median(samplesNsPerOp),
    retainedHeapDelta: retained.heapSize - before.heapSize,
    retainedExtraMemoryDelta:
      retained.extraMemorySize - before.extraMemorySize,
    retainedObjectDelta: retained.objectCount - before.objectCount,
    jit,
    checksum,
  };
}

const scenarioName: ScenarioName = parseScenarioName(process.argv[2]);
const result: BenchmarkResult = await runBenchmark(scenarioName);
process.stdout.write(`${JSON.stringify(result)}\n`);

if (aiReplyActivitySweepState.timer !== null || aiReplyActivityByChat.size > 0) {
  clearAiReplyActivity();
}
