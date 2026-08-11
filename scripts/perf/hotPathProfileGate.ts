/**
 * 固定 Bun、固定场景、独立进程重复的热路径内存/GC 门禁。
 *
 * 每个子进程只在预热后的正式循环开启 JSC sampling profiler，因此 GC 比例不含
 * import、预热和 retained-heap 强制 GC。RSS 使用进程生命周期峰值；heapUsed 增长
 * 使用每个正式采样节拍的观测峰值。脚本串行运行，避免场景之间争抢资源。
 */

import { join } from "node:path";
import { isPlainRecord } from "../../packages/libs/record";
import {
  HOT_PATH_PROFILE_BUN_REVISION,
  HOT_PATH_PROFILE_BUN_VERSION,
  HOT_PATH_PROFILE_MAX_GC_PERCENT,
  HOT_PATH_PROFILE_MAX_RSS_BYTES,
  HOT_PATH_PROFILE_MAX_SAMPLED_HEAP_GROWTH_BYTES,
  HOT_PATH_PROFILE_MIN_FTL_PERCENT,
  HOT_PATH_PROFILE_MIN_SAMPLES,
  HOT_PATH_PROFILE_REPEATS,
  HOT_PATH_PROFILE_SCENARIOS,
} from "../../packages/consts/performance";

interface SamplingProfileResult {
  readonly totalSamples: number;
  readonly gcSamples: number;
  readonly gcPercent: number;
  readonly llintPercent: number;
  readonly baselinePercent: number;
  readonly dfgPercent: number;
  readonly ftlPercent: number;
}

interface JitProbeResult {
  readonly dfgCompiles: number;
  readonly reoptRetries: number;
  readonly changedDuringSampling: boolean;
}

interface ChildProfileResult {
  readonly scenario: string;
  readonly measurementMode: string;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly warmupIterations: number;
  readonly medianNsPerOp: number;
  readonly peakSampledHeapUsedDelta: number;
  readonly processPeakRssBytes: number;
  readonly samplingProfile: SamplingProfileResult;
  readonly jit: Readonly<Record<string, JitProbeResult>>;
}

interface ScenarioGateResult {
  readonly scenario: string;
  readonly repeats: number;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly maxGcPercent: number;
  readonly maxProcessPeakRssBytes: number;
  readonly maxSampledHeapUsedGrowthBytes: number;
  readonly minProfileSamples: number;
  readonly minFtlPercent: number;
  readonly minProductionProbeDfgCompiles: number;
  readonly maxProductionProbeReoptRetries: number;
  readonly maxWarmupIterations: number;
  readonly minMedianOpsPerSecond: number;
  readonly minMedianNsPerOp: number;
  readonly maxMedianNsPerOp: number;
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string
): string {
  const value: unknown = record[key];
  if (typeof value !== "string") {
    throw new Error(`Hot-path child result omitted string field ${key}.`);
  }
  return value;
}

function requiredNumber(
  record: Readonly<Record<string, unknown>>,
  key: string
): number {
  const value: unknown = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Hot-path child result omitted finite number field ${key}.`);
  }
  return value;
}

function requiredBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string
): boolean {
  const value: unknown = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Hot-path child result omitted boolean field ${key}.`);
  }
  return value;
}

function parseSamplingProfile(value: unknown): SamplingProfileResult {
  if (!isPlainRecord(value)) {
    throw new Error("Hot-path child result omitted its sampling profile.");
  }
  return {
    totalSamples: requiredNumber(value, "totalSamples"),
    gcSamples: requiredNumber(value, "gcSamples"),
    gcPercent: requiredNumber(value, "gcPercent"),
    llintPercent: requiredNumber(value, "llintPercent"),
    baselinePercent: requiredNumber(value, "baselinePercent"),
    dfgPercent: requiredNumber(value, "dfgPercent"),
    ftlPercent: requiredNumber(value, "ftlPercent"),
  };
}

function parseJitProbes(value: unknown): Readonly<Record<string, JitProbeResult>> {
  if (!isPlainRecord(value)) {
    throw new Error("Hot-path child result omitted its JIT probes.");
  }
  const probes: Record<string, JitProbeResult> = {};
  for (const [name, probe] of Object.entries(value)) {
    if (!isPlainRecord(probe)) {
      throw new Error(`Hot-path child returned an invalid JIT probe ${name}.`);
    }
    probes[name] = {
      dfgCompiles: requiredNumber(probe, "dfgCompiles"),
      reoptRetries: requiredNumber(probe, "reoptRetries"),
      changedDuringSampling: requiredBoolean(probe, "changedDuringSampling"),
    };
  }
  return probes;
}

function parseChildProfileResult(text: string): ChildProfileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Hot-path child did not return valid JSON.");
  }
  if (!isPlainRecord(parsed)) {
    throw new Error("Hot-path child result must be a JSON object.");
  }
  return {
    scenario: requiredString(parsed, "scenario"),
    measurementMode: requiredString(parsed, "measurementMode"),
    bunVersion: requiredString(parsed, "bunVersion"),
    bunRevision: requiredString(parsed, "bunRevision"),
    warmupIterations: requiredNumber(parsed, "warmupIterations"),
    medianNsPerOp: requiredNumber(parsed, "medianNsPerOp"),
    peakSampledHeapUsedDelta: requiredNumber(
      parsed,
      "peakSampledHeapUsedDelta"
    ),
    processPeakRssBytes: requiredNumber(parsed, "processPeakRssBytes"),
    samplingProfile: parseSamplingProfile(parsed.samplingProfile),
    jit: parseJitProbes(parsed.jit),
  };
}

/**
 * scenario.run 可能只是 async 编排壳，不能代表内部生产函数是否已优化；默认门禁
 * 场景都显式登记生产探针，因此只对这些探针要求预热后已进 DFG 且采样期无重编译。
 */
function productionJitProbes(result: ChildProfileResult): readonly JitProbeResult[] {
  const probes: JitProbeResult[] = [];
  for (const [name, probe] of Object.entries(result.jit)) {
    if (name !== "scenario.run") probes.push(probe);
  }
  if (probes.length === 0) {
    throw new Error(`${result.scenario}: profile scenario has no production JIT probes.`);
  }
  return probes;
}

function assertRunWithinLimits(result: ChildProfileResult): void {
  if (
    result.bunVersion !== HOT_PATH_PROFILE_BUN_VERSION ||
    result.bunRevision !== HOT_PATH_PROFILE_BUN_REVISION
  ) {
    throw new Error(
      `${result.scenario}: expected Bun ${HOT_PATH_PROFILE_BUN_VERSION} ` +
      `(${HOT_PATH_PROFILE_BUN_REVISION}), received ${result.bunVersion} ` +
      `(${result.bunRevision}); recalibrate the profile thresholds before comparing results.`
    );
  }
  if (result.measurementMode !== "steadyProfile") {
    throw new Error(`${result.scenario}: child did not run in steadyProfile mode.`);
  }
  if (
    !Number.isSafeInteger(result.warmupIterations) ||
    result.warmupIterations <= 0
  ) {
    throw new Error(`${result.scenario}: child returned invalid warmup iterations.`);
  }
  if (result.medianNsPerOp <= 0) {
    throw new Error(`${result.scenario}: child returned invalid median latency.`);
  }
  if (result.samplingProfile.totalSamples < HOT_PATH_PROFILE_MIN_SAMPLES) {
    throw new Error(
      `${result.scenario}: only ${result.samplingProfile.totalSamples} profile samples; ` +
      `expected at least ${HOT_PATH_PROFILE_MIN_SAMPLES}.`
    );
  }
  if (result.samplingProfile.gcPercent > HOT_PATH_PROFILE_MAX_GC_PERCENT) {
    throw new Error(
      `${result.scenario}: GC used ${result.samplingProfile.gcPercent.toFixed(3)}% of ` +
      `steady samples; limit is ${HOT_PATH_PROFILE_MAX_GC_PERCENT}%.`
    );
  }
  if (result.samplingProfile.ftlPercent < HOT_PATH_PROFILE_MIN_FTL_PERCENT) {
    throw new Error(
      `${result.scenario}: FTL covered only ${result.samplingProfile.ftlPercent.toFixed(3)}% ` +
      `of steady samples; expected at least ${HOT_PATH_PROFILE_MIN_FTL_PERCENT}%.`
    );
  }
  if (result.processPeakRssBytes > HOT_PATH_PROFILE_MAX_RSS_BYTES) {
    throw new Error(
      `${result.scenario}: process RSS peaked at ${result.processPeakRssBytes} bytes; ` +
      `limit is ${HOT_PATH_PROFILE_MAX_RSS_BYTES}.`
    );
  }
  if (
    result.peakSampledHeapUsedDelta >
      HOT_PATH_PROFILE_MAX_SAMPLED_HEAP_GROWTH_BYTES
  ) {
    throw new Error(
      `${result.scenario}: sampled heapUsed grew by ${result.peakSampledHeapUsedDelta} bytes; ` +
      `limit is ${HOT_PATH_PROFILE_MAX_SAMPLED_HEAP_GROWTH_BYTES}.`
    );
  }
  for (const probe of productionJitProbes(result)) {
    if (probe.dfgCompiles < 1) {
      throw new Error(
        `${result.scenario}: a production probe did not enter DFG during warmup.`
      );
    }
    if (probe.changedDuringSampling) {
      throw new Error(
        `${result.scenario}: a production probe recompiled or deoptimized during steady sampling.`
      );
    }
  }
}

async function runChild(
  projectRoot: string,
  scenario: string
): Promise<ChildProfileResult> {
  const subprocess: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    [
      process.execPath,
      join(projectRoot, "scripts/perf/hotPaths.ts"),
      scenario,
      "--profile",
    ],
    {
      cwd: projectRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdoutPromise: Promise<string> = new Response(subprocess.stdout).text();
  const stderrPromise: Promise<string> = new Response(subprocess.stderr).text();
  const exitCode: number = await subprocess.exited;
  const stdout: string = await stdoutPromise;
  const stderr: string = await stderrPromise;
  if (exitCode !== 0) {
    throw new Error(
      `${scenario}: hot-path profile child exited ${exitCode}: ${stderr.trim()}`
    );
  }
  const result: ChildProfileResult = parseChildProfileResult(stdout.trim());
  if (result.scenario !== scenario) {
    throw new Error(`${scenario}: child returned scenario ${result.scenario}.`);
  }
  assertRunWithinLimits(result);
  return result;
}

function maximum(values: readonly number[]): number {
  return Math.max(...values);
}

function minimum(values: readonly number[]): number {
  return Math.min(...values);
}

const projectRoot: string = join(import.meta.dir, "../..");
const gateResults: ScenarioGateResult[] = [];
let expectedBunVersion: string | undefined;
let expectedBunRevision: string | undefined;

for (const scenario of HOT_PATH_PROFILE_SCENARIOS) {
  const runs: ChildProfileResult[] = [];
  for (let repeat: number = 0; repeat < HOT_PATH_PROFILE_REPEATS; repeat++) {
    const run: ChildProfileResult = await runChild(projectRoot, scenario);
    expectedBunVersion ??= run.bunVersion;
    expectedBunRevision ??= run.bunRevision;
    if (
      run.bunVersion !== expectedBunVersion ||
      run.bunRevision !== expectedBunRevision
    ) {
      throw new Error(`${scenario}: Bun version changed during the profile gate.`);
    }
    runs.push(run);
  }
  const reference: ChildProfileResult | undefined = runs[0];
  if (reference === undefined) {
    throw new Error(`${scenario}: profile gate did not execute any repeats.`);
  }
  gateResults.push({
    scenario,
    repeats: runs.length,
    bunVersion: reference.bunVersion,
    bunRevision: reference.bunRevision,
    maxGcPercent: maximum(runs.map(
      (run: ChildProfileResult): number => run.samplingProfile.gcPercent
    )),
    maxProcessPeakRssBytes: maximum(runs.map(
      (run: ChildProfileResult): number => run.processPeakRssBytes
    )),
    maxSampledHeapUsedGrowthBytes: maximum(runs.map(
      (run: ChildProfileResult): number => run.peakSampledHeapUsedDelta
    )),
    minProfileSamples: minimum(runs.map(
      (run: ChildProfileResult): number => run.samplingProfile.totalSamples
    )),
    minFtlPercent: minimum(runs.map(
      (run: ChildProfileResult): number => run.samplingProfile.ftlPercent
    )),
    minProductionProbeDfgCompiles: minimum(runs.flatMap(
      (run: ChildProfileResult): readonly number[] => productionJitProbes(run).map(
        (probe: JitProbeResult): number => probe.dfgCompiles
      )
    )),
    maxProductionProbeReoptRetries: maximum(runs.flatMap(
      (run: ChildProfileResult): readonly number[] => productionJitProbes(run).map(
        (probe: JitProbeResult): number => probe.reoptRetries
      )
    )),
    maxWarmupIterations: maximum(runs.map(
      (run: ChildProfileResult): number => run.warmupIterations
    )),
    minMedianOpsPerSecond: 1_000_000_000 / maximum(runs.map(
      (run: ChildProfileResult): number => run.medianNsPerOp
    )),
    minMedianNsPerOp: minimum(runs.map(
      (run: ChildProfileResult): number => run.medianNsPerOp
    )),
    maxMedianNsPerOp: maximum(runs.map(
      (run: ChildProfileResult): number => run.medianNsPerOp
    )),
  });
}

if (expectedBunVersion === undefined || expectedBunRevision === undefined) {
  throw new Error("Hot-path profile gate has no configured scenarios.");
}

process.stdout.write(`${JSON.stringify({
  bunVersion: expectedBunVersion,
  bunRevision: expectedBunRevision,
  thresholds: {
    maxGcPercent: HOT_PATH_PROFILE_MAX_GC_PERCENT,
    maxProcessPeakRssBytes: HOT_PATH_PROFILE_MAX_RSS_BYTES,
    maxSampledHeapUsedGrowthBytes:
      HOT_PATH_PROFILE_MAX_SAMPLED_HEAP_GROWTH_BYTES,
    minProfileSamples: HOT_PATH_PROFILE_MIN_SAMPLES,
    minFtlPercent: HOT_PATH_PROFILE_MIN_FTL_PERCENT,
  },
  scenarios: gateResults,
})}\n`);
