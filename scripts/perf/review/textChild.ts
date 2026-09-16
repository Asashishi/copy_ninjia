/**
 * 文本清洗专项的单场景测量子进程：直接调用生产 sanitizeInline 与
 * buildBufferedMessage，预热至 JIT 探针稳定后正式采样，报告耗时、内存、JIT 分层；
 * GC 暂停由父进程从本进程 stderr 的唯一测量窗口解析。
 */
import { COMPACT_BATCH_SIZE } from "../../../packages/consts/aiChat/memory";
import { sanitizeInline } from "../../../packages/libs/text";
import { buildBufferedMessage } from "../../../packages/workers/aiChat/bufferedMessage";
import type { BufferedMessage } from "../../../packages/types/aiChat/memory";
import { snapshotHeap } from "../heapSnapshot";
import type { HeapSnapshot } from "../heapSnapshot";
import { beginGcProfileWindow, endGcProfileWindow } from "../hotPaths/gcProfile";
import { collectJitTiers, diffJitTiers } from "../hotPaths/jitTiers";
import { readProcessMemoryUsage } from "../hotPaths/liveMemory";
import type { JitTierCounts, JitTierStats, Scenario } from "../hotPaths/types";
import { median } from "../statistics";
import { findTextReviewScenario, textReviewInputs, textReviewIterations } from "./textFixture";
import type { TextReviewInput, TextReviewScenario } from "./textFixture";

/** 正式计时样本数。 */
const SAMPLE_COUNT: number = 9;
/** 判定稳态所需的连续不变预热样本数。 */
const REQUIRED_STABLE_WARMUP_SAMPLES: number = 3;
/** 预热样本上限；到上限仍未稳定则拒绝给出读数。 */
const MAX_WARMUP_SAMPLES: number = 30;

/** 本子进程写到 stdout 的读数。 */
export interface TextReviewChildResult {
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly scenario: string;
  readonly iterations: number;
  readonly averageLength: number;
  readonly warmupSamples: number;
  readonly samplesNsPerOp: readonly number[];
  readonly medianNsPerOp: number;
  readonly peakSampledHeapUsedDelta: number;
  readonly peakSampledRssDelta: number;
  readonly retainedHeapDelta: number;
  readonly retainedObjectDelta: number;
  readonly jit: Readonly<Record<string, JitTierStats>>;
  readonly jitStableDuringSampling: boolean;
  readonly checksum: number;
}

const definition: TextReviewScenario = findTextReviewScenario(Bun.argv[2]);
const inputs: readonly TextReviewInput[] = textReviewInputs(definition);
const iterations: number = textReviewIterations(definition, inputs);
let averageLength: number = 0;
for (const input of inputs) averageLength += input.text.length / inputs.length;
// 构造结果按生产压缩批次大小留存，保证消息对象逃逸而不被优化掉。
const retainedWindow: (BufferedMessage | null)[] = new Array<BufferedMessage | null>(COMPACT_BATCH_SIZE).fill(null);
let checksum: number = 0;

function runSanitize(count: number): number {
  for (let index: number = 0; index < count; index++) {
    const value: string = sanitizeInline(inputs[index % inputs.length]!.text);
    checksum = (checksum + value.length + value.charCodeAt(0)) | 0;
  }
  return checksum;
}

function runMessage(count: number): number {
  for (let index: number = 0; index < count; index++) {
    const input: TextReviewInput = inputs[index % inputs.length]!;
    // 不传时刻：计入生产默认的 Date.now() 与东京时间格式化。
    const value: BufferedMessage | null = buildBufferedMessage(input.source, input.text);
    if (value === null) throw new Error(`${definition.name}: fixture message was discarded.`);
    retainedWindow[index % COMPACT_BATCH_SIZE] = value;
    checksum = (checksum + value.text.length + value.firstName.length + value.at.length +
      (value.replyTo?.text.length ?? 0)) | 0;
  }
  return checksum;
}

const run: (count: number) => number = definition.kind === "sanitize" ? runSanitize : runMessage;
const scenario: Scenario = definition.kind === "sanitize"
  ? { iterations, run, probes: { sanitizeInline } }
  : { iterations, run, probes: { sanitizeInline, buildBufferedMessage } };

function sampleNsPerOp(): number {
  const startedAt: number = Bun.nanoseconds();
  run(iterations);
  return (Bun.nanoseconds() - startedAt) / iterations;
}

function tiersAreStable(
  before: Readonly<Record<string, JitTierCounts>>,
  after: Readonly<Record<string, JitTierCounts>>
): boolean {
  for (const [name, sampled] of Object.entries(after)) {
    const warmed: JitTierCounts | undefined = before[name];
    if (warmed === undefined || sampled.dfgCompiles < 1 ||
      sampled.dfgCompiles !== warmed.dfgCompiles || sampled.reoptRetries !== warmed.reoptRetries) return false;
  }
  return true;
}

let tiersAfterWarmup: Record<string, JitTierCounts> = collectJitTiers(scenario);
let stableSamples: number = 0;
let warmupSamples: number = 0;
while (stableSamples < REQUIRED_STABLE_WARMUP_SAMPLES && warmupSamples < MAX_WARMUP_SAMPLES) {
  sampleNsPerOp();
  // 与正式样本做同样的内存读取：进程内首次 process.memoryUsage() 会让已编译的
  // 热函数重新编译，必须落在预热内，稳定判定才对正式采样成立。
  readProcessMemoryUsage();
  warmupSamples++;
  const next: Record<string, JitTierCounts> = collectJitTiers(scenario);
  stableSamples = tiersAreStable(tiersAfterWarmup, next) ? stableSamples + 1 : 0;
  tiersAfterWarmup = next;
}
if (stableSamples < REQUIRED_STABLE_WARMUP_SAMPLES) {
  throw new Error(`${definition.name}: JIT probes did not stabilize before formal sampling.`);
}

const before: NodeJS.MemoryUsage = readProcessMemoryUsage();
let peakHeapUsed: number = before.heapUsed;
let peakRss: number = before.rss;
const samplesNsPerOp: number[] = [];
const gcWindowStartedAt: number = beginGcProfileWindow();
for (let sample: number = 0; sample < SAMPLE_COUNT; sample++) {
  samplesNsPerOp.push(sampleNsPerOp());
  const memory: NodeJS.MemoryUsage = readProcessMemoryUsage();
  peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
  peakRss = Math.max(peakRss, memory.rss);
}
endGcProfileWindow(gcWindowStartedAt);
const jit: Record<string, JitTierStats> = diffJitTiers(tiersAfterWarmup, collectJitTiers(scenario));

// 留存诊断在计时窗口之外单独跑一轮，前后各做一次完整 GC。
Bun.gc(true);
const retainedBefore: HeapSnapshot = snapshotHeap();
run(iterations);
Bun.gc(true);
const retainedAfter: HeapSnapshot = snapshotHeap();

const result: TextReviewChildResult = {
  bunVersion: Bun.version,
  bunRevision: Bun.revision,
  scenario: definition.name,
  iterations,
  averageLength,
  warmupSamples,
  samplesNsPerOp,
  medianNsPerOp: median(samplesNsPerOp),
  peakSampledHeapUsedDelta: peakHeapUsed - before.heapUsed,
  peakSampledRssDelta: peakRss - before.rss,
  retainedHeapDelta: retainedAfter.heapSize - retainedBefore.heapSize,
  retainedObjectDelta: retainedAfter.objectCount - retainedBefore.objectCount,
  jit,
  jitStableDuringSampling: Object.values(jit).every((tier: JitTierStats): boolean => !tier.changedDuringSampling),
  checksum,
};
await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
