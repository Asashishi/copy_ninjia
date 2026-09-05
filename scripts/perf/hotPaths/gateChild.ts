/** 热路径门禁子进程的解码、运行时校验、资源门禁与隔离根清理。 */

import { join } from "node:path";
import { isPlainRecord } from "../../../packages/libs/record";
import {
  createHotPathGateRuntimeRoot,
  hotPathGateChildEnvironment,
  removeHotPathGateRuntimeRoot,
} from "./gateFixture";
import type { HotPathGateFixture } from "./gateFixture";
import type { HotPathGateCalibration } from "./gateResult";

export interface SamplingProfileResult {
  readonly totalSamples: number;
  readonly gcSamples: number;
  readonly gcPercent: number;
  readonly llintPercent: number;
  readonly baselinePercent: number;
  readonly dfgPercent: number;
  readonly ftlPercent: number;
}

export interface JitProbeResult {
  readonly dfgCompiles: number;
  readonly reoptRetries: number;
  readonly changedDuringSampling: boolean;
}

export interface ChildProfileResult {
  readonly scenario: string;
  readonly measurementMode: string;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly warmupIterations: number;
  readonly medianNsPerOp: number;
  readonly retainedHeapDelta: number | null;
  readonly retainedExtraMemoryDelta: number | null;
  readonly retainedObjectDelta: number | null;
  readonly peakSampledHeapUsedDelta: number;
  readonly peakSampledRssBytes: number;
  readonly processPeakRssBytes: number;
  readonly samplingProfile: SamplingProfileResult | null;
  readonly jit: Readonly<Record<string, JitProbeResult>>;
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

function requiredNullableNumber(
  record: Readonly<Record<string, unknown>>,
  key: string
): number | null {
  const value: unknown = record[key];
  if (value === null) return null;
  return requiredNumber(record, key);
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
    parsed = JSON.parse(text) as unknown;
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
    retainedHeapDelta: requiredNullableNumber(parsed, "retainedHeapDelta"),
    retainedExtraMemoryDelta: requiredNullableNumber(parsed, "retainedExtraMemoryDelta"),
    retainedObjectDelta: requiredNullableNumber(parsed, "retainedObjectDelta"),
    peakSampledHeapUsedDelta: requiredNumber(parsed, "peakSampledHeapUsedDelta"),
    peakSampledRssBytes: requiredNumber(parsed, "peakSampledRssBytes"),
    processPeakRssBytes: requiredNumber(parsed, "processPeakRssBytes"),
    samplingProfile: parsed.samplingProfile === null
      ? null
      : parseSamplingProfile(parsed.samplingProfile),
    jit: parseJitProbes(parsed.jit),
  };
}

/** 只返回生产探针；scenario.run 编排壳不能证明内部函数已进入 DFG。 */
export function productionJitProbes(
  result: ChildProfileResult
): readonly JitProbeResult[] {
  const probes: JitProbeResult[] = [];
  for (const [name, probe] of Object.entries(result.jit)) {
    if (name !== "scenario.run") probes.push(probe);
  }
  if (probes.length === 0) {
    throw new Error(`${result.scenario}: profile scenario has no production JIT probes.`);
  }
  return probes;
}

function assertRuntimeMatches(
  result: ChildProfileResult,
  calibration: HotPathGateCalibration
): void {
  if (
    result.bunVersion !== calibration.runtime.bunVersion ||
    result.bunRevision !== calibration.runtime.bunRevision
  ) {
    throw new Error(
      `${result.scenario}: expected Bun ${calibration.runtime.bunVersion} ` +
      `(${calibration.runtime.bunRevision}), received ${result.bunVersion} ` +
      `(${result.bunRevision}); recalibrate the profile thresholds before comparing results.`
    );
  }
  if (!Number.isSafeInteger(result.warmupIterations) || result.warmupIterations <= 0) {
    throw new Error(`${result.scenario}: child returned invalid warmup iterations.`);
  }
  if (result.medianNsPerOp <= 0) {
    throw new Error(`${result.scenario}: child returned invalid median latency.`);
  }
}

function assertProfileRunWithinLimits(
  result: ChildProfileResult,
  calibration: HotPathGateCalibration
): void {
  assertRuntimeMatches(result, calibration);
  if (result.measurementMode !== "steadyProfile" || result.samplingProfile === null) {
    throw new Error(`${result.scenario}: child did not return a sampling profile.`);
  }
  if (result.samplingProfile.totalSamples < calibration.limits.minProfileSamples) {
    throw new Error(
      `${result.scenario}: only ${result.samplingProfile.totalSamples} profile samples; ` +
      `expected at least ${calibration.limits.minProfileSamples}.`
    );
  }
  if (result.samplingProfile.gcPercent > calibration.limits.maxGcPercent) {
    throw new Error(
      `${result.scenario}: GC used ${result.samplingProfile.gcPercent.toFixed(3)}% of ` +
      `steady samples; limit is ${calibration.limits.maxGcPercent}%.`
    );
  }
  for (const probe of productionJitProbes(result)) {
    if (probe.dfgCompiles < 1) {
      throw new Error(`${result.scenario}: a production probe did not enter DFG during warmup.`);
    }
    if (probe.changedDuringSampling) {
      throw new Error(
        `${result.scenario}: a production probe recompiled or deoptimized during steady sampling.`
      );
    }
  }
}

function assertRetainedRunWithinLimits(
  result: ChildProfileResult,
  calibration: HotPathGateCalibration
): void {
  assertRuntimeMatches(result, calibration);
  if (
    result.measurementMode !== "retained" ||
    result.samplingProfile !== null ||
    result.retainedHeapDelta === null ||
    result.retainedExtraMemoryDelta === null ||
    result.retainedObjectDelta === null
  ) {
    throw new Error(`${result.scenario}: child did not return retained-memory results.`);
  }
  if (
    result.peakSampledRssBytes > calibration.limits.maxRssBytes ||
    result.processPeakRssBytes > calibration.limits.maxRssBytes
  ) {
    throw new Error(`${result.scenario}: RSS exceeded ${calibration.limits.maxRssBytes} bytes.`);
  }
  if (result.peakSampledHeapUsedDelta > calibration.limits.maxSampledHeapGrowthBytes) {
    throw new Error(`${result.scenario}: sampled heapUsed growth exceeded its limit.`);
  }
  if (result.retainedHeapDelta > calibration.limits.maxRetainedHeapGrowthBytes) {
    throw new Error(`${result.scenario}: retained JSC heap growth exceeded its limit.`);
  }
  if (
    result.retainedExtraMemoryDelta >
      calibration.limits.maxRetainedExtraMemoryGrowthBytes
  ) {
    throw new Error(`${result.scenario}: retained extra memory growth exceeded its limit.`);
  }
  if (result.retainedObjectDelta > calibration.limits.maxRetainedObjectGrowth) {
    throw new Error(`${result.scenario}: retained object growth exceeded its limit.`);
  }
}

export interface RunHotPathGateChildOptions {
  readonly projectRoot: string;
  readonly scenario: string;
  readonly measurementMode: "retained" | "steadyProfile";
  readonly fixture: HotPathGateFixture;
  readonly calibration: HotPathGateCalibration;
}

/** 运行一轮隔离子进程，严格解码并执行对应的 profile 或 retained 门禁。 */
export async function runHotPathGateChild({
  projectRoot,
  scenario,
  measurementMode,
  fixture,
  calibration,
}: RunHotPathGateChildOptions): Promise<ChildProfileResult> {
  const args: string[] = [
    Bun.argv[0]!,
    join(projectRoot, "scripts/perf/hotPaths.ts"),
    scenario,
  ];
  if (measurementMode === "steadyProfile") args.push("--profile");
  const runtimeRoot: string = createHotPathGateRuntimeRoot(fixture);
  try {
    const subprocess: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(args, {
      cwd: projectRoot,
      env: hotPathGateChildEnvironment(fixture, runtimeRoot),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise: Promise<string> = subprocess.stdout.text();
    const stderrPromise: Promise<string> = subprocess.stderr.text();
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
    if (measurementMode === "steadyProfile") {
      assertProfileRunWithinLimits(result, calibration);
    } else {
      assertRetainedRunWithinLimits(result, calibration);
    }
    return result;
  } finally {
    removeHotPathGateRuntimeRoot(runtimeRoot);
  }
}
