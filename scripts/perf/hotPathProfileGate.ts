/**
 * 固定 Bun、固定场景、独立进程重复的热路径内存/GC/JIT 门禁。
 *
 * 每个场景分别运行 sampling-profile 与 retained 子进程；子进程解码和硬门禁在
 * hotPaths/gateChild.ts，本文件只负责场景编排、跨轮汇总与结果发布。
 */

import { join } from "node:path";
import {
  HOT_PATH_PROFILE_REPEATS,
  HOT_PATH_PROFILE_SCENARIOS,
} from "../../packages/consts/performance";
import {
  assertHotPathMedianPolicyCoverage,
  createHotPathMedianLatencyReport,
} from "./hotPaths/gateLimits";
import type { HotPathMedianLatencyReport } from "./hotPaths/gateLimits";
import {
  readHotPathGateCalibration,
  writeHotPathGateLastRun,
} from "./hotPaths/gateResult";
import type { HotPathGateCalibration } from "./hotPaths/gateResult";
import {
  createHotPathGateFixture,
  removeHotPathGateFixture,
} from "./hotPaths/gateFixture";
import type { HotPathGateFixture } from "./hotPaths/gateFixture";
import {
  productionJitProbes,
  runHotPathGateChild,
} from "./hotPaths/gateChild";
import type {
  ChildProfileResult,
  JitProbeResult,
} from "./hotPaths/gateChild";
import { PERFORMANCE_RESULT_PATH } from "./performanceResult";
import { collectRuntimeCalibrationProblems } from "./hotPaths/gateRuntime";

interface ScenarioGateResult {
  readonly scenario: string;
  readonly repeats: number;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly maxGcPercent: number;
  readonly maxSampledRssBytes: number;
  readonly maxProcessPeakRssBytes: number;
  readonly maxSampledHeapUsedGrowthBytes: number;
  readonly maxRetainedHeapGrowthBytes: number;
  readonly maxRetainedExtraMemoryGrowthBytes: number;
  readonly maxRetainedObjectGrowth: number;
  readonly minProfileSamples: number;
  readonly minFtlPercentDiagnostic: number;
  readonly minProductionProbeDfgCompiles: number;
  readonly maxProductionProbeReoptRetriesDiagnostic: number;
  readonly maxProfileWarmupIterations: number;
  readonly maxRetainedWarmupIterations: number;
  readonly minMedianOpsPerSecondDiagnostic: number;
  readonly minMedianNsPerOpDiagnostic: number;
  readonly maxMedianNsPerOpDiagnostic: number;
}

const projectRoot: string = join(import.meta.dir, "../..");
const runtimeProblems: readonly string[] = await collectRuntimeCalibrationProblems({ projectRoot });
if (runtimeProblems.length > 0) throw new Error(runtimeProblems.join("\n"));
const calibration: HotPathGateCalibration = await readHotPathGateCalibration(
  PERFORMANCE_RESULT_PATH
);
const shouldWriteResult: boolean = Bun.argv.includes("--write-result");
const gateFixture: HotPathGateFixture = await createHotPathGateFixture();
let gateFixturePresent: boolean = true;

function cleanupGateFixture(): void {
  if (!gateFixturePresent) return;
  removeHotPathGateFixture(gateFixture);
  gateFixturePresent = false;
}

function maximum(values: readonly number[]): number {
  return Math.max(...values);
}

function minimum(values: readonly number[]): number {
  return Math.min(...values);
}

process.once("exit", cleanupGateFixture);

const gateResults: ScenarioGateResult[] = [];
const softLatencyReports: HotPathMedianLatencyReport[] = [];
let expectedBunVersion: string | undefined;
let expectedBunRevision: string | undefined;
const medianLatencyPolicy: ReadonlyMap<string, number> =
  assertHotPathMedianPolicyCoverage(
    HOT_PATH_PROFILE_SCENARIOS,
    calibration.medianNsPerOpReportThresholds
  );

for (const [scenario, reportThresholdNsPerOp] of medianLatencyPolicy) {
  const profileRuns: ChildProfileResult[] = [];
  const retainedRuns: ChildProfileResult[] = [];
  for (let repeat: number = 0; repeat < HOT_PATH_PROFILE_REPEATS; repeat += 1) {
    const profileRun: ChildProfileResult = await runHotPathGateChild({
      projectRoot,
      scenario,
      measurementMode: "steadyProfile",
      fixture: gateFixture,
      calibration,
    });
    const retainedRun: ChildProfileResult = await runHotPathGateChild({
      projectRoot,
      scenario,
      measurementMode: "retained",
      fixture: gateFixture,
      calibration,
    });
    expectedBunVersion ??= profileRun.bunVersion;
    expectedBunRevision ??= profileRun.bunRevision;
    if (
      profileRun.bunVersion !== expectedBunVersion ||
      profileRun.bunRevision !== expectedBunRevision ||
      retainedRun.bunVersion !== expectedBunVersion ||
      retainedRun.bunRevision !== expectedBunRevision
    ) {
      throw new Error(`${scenario}: Bun version changed during the profile gate.`);
    }
    profileRuns.push(profileRun);
    retainedRuns.push(retainedRun);
  }
  const reference: ChildProfileResult | undefined = profileRuns[0];
  if (reference === undefined) {
    throw new Error(`${scenario}: profile gate did not execute any repeats.`);
  }
  const medianNsPerOps: number[] = retainedRuns.map(
    (run: ChildProfileResult): number => run.medianNsPerOp
  );
  const maxMedianNsPerOp: number = maximum(medianNsPerOps);
  const latencyReport: HotPathMedianLatencyReport | null =
    createHotPathMedianLatencyReport({
      scenario,
      medianNsPerOp: maxMedianNsPerOp,
      bunRevision: reference.bunRevision,
      reportThresholdNsPerOp,
    });
  if (latencyReport !== null) softLatencyReports.push(latencyReport);
  gateResults.push({
    scenario,
    repeats: profileRuns.length,
    bunVersion: reference.bunVersion,
    bunRevision: reference.bunRevision,
    maxGcPercent: maximum(profileRuns.map(
      (run: ChildProfileResult): number => run.samplingProfile!.gcPercent
    )),
    maxSampledRssBytes: maximum(retainedRuns.map(
      (run: ChildProfileResult): number => run.peakSampledRssBytes
    )),
    maxProcessPeakRssBytes: maximum(retainedRuns.map(
      (run: ChildProfileResult): number => run.processPeakRssBytes
    )),
    maxSampledHeapUsedGrowthBytes: maximum(retainedRuns.map(
      (run: ChildProfileResult): number => run.peakSampledHeapUsedDelta
    )),
    maxRetainedHeapGrowthBytes: maximum(retainedRuns.map(
      (run: ChildProfileResult): number => run.retainedHeapDelta!
    )),
    maxRetainedExtraMemoryGrowthBytes: maximum(retainedRuns.map(
      (run: ChildProfileResult): number => run.retainedExtraMemoryDelta!
    )),
    maxRetainedObjectGrowth: maximum(retainedRuns.map(
      (run: ChildProfileResult): number => run.retainedObjectDelta!
    )),
    minProfileSamples: minimum(profileRuns.map(
      (run: ChildProfileResult): number => run.samplingProfile!.totalSamples
    )),
    minFtlPercentDiagnostic: minimum(profileRuns.map(
      (run: ChildProfileResult): number => run.samplingProfile!.ftlPercent
    )),
    minProductionProbeDfgCompiles: minimum(profileRuns.flatMap(
      (run: ChildProfileResult): readonly number[] => productionJitProbes(run).map(
        (probe: JitProbeResult): number => probe.dfgCompiles
      )
    )),
    maxProductionProbeReoptRetriesDiagnostic: maximum(profileRuns.flatMap(
      (run: ChildProfileResult): readonly number[] => productionJitProbes(run).map(
        (probe: JitProbeResult): number => probe.reoptRetries
      )
    )),
    maxProfileWarmupIterations: maximum(profileRuns.map(
      (run: ChildProfileResult): number => run.warmupIterations
    )),
    maxRetainedWarmupIterations: maximum(retainedRuns.map(
      (run: ChildProfileResult): number => run.warmupIterations
    )),
    minMedianOpsPerSecondDiagnostic: 1_000_000_000 / maxMedianNsPerOp,
    minMedianNsPerOpDiagnostic: minimum(medianNsPerOps),
    maxMedianNsPerOpDiagnostic: maxMedianNsPerOp,
  });
}

if (expectedBunVersion === undefined || expectedBunRevision === undefined) {
  throw new Error("Hot-path profile gate has no configured scenarios.");
}
for (const report of softLatencyReports) {
  console.error(
    `hot-path soft latency: ${report.scenario} median ${report.medianNsPerOp.toFixed(1)} ns/op ` +
    `exceeds its ${report.reportThresholdNsPerOp} ns/op policy by ` +
    `${report.overrunNsPerOp.toFixed(1)} ns/op (+${report.overrunPercent.toFixed(1)}%) ` +
    `on Bun ${expectedBunRevision}.`
  );
}

const lastRun: Readonly<Record<string, unknown>> = {
  recordedAt: new Date().toISOString(),
  bunVersion: expectedBunVersion,
  bunRevision: expectedBunRevision,
  thresholds: {
    maxGcPercent: calibration.limits.maxGcPercent,
    maxSampledRssBytes: calibration.limits.maxRssBytes,
    maxProcessPeakRssBytes: calibration.limits.maxRssBytes,
    maxSampledHeapUsedGrowthBytes: calibration.limits.maxSampledHeapGrowthBytes,
    maxRetainedHeapGrowthBytes: calibration.limits.maxRetainedHeapGrowthBytes,
    maxRetainedExtraMemoryGrowthBytes:
      calibration.limits.maxRetainedExtraMemoryGrowthBytes,
    maxRetainedObjectGrowth: calibration.limits.maxRetainedObjectGrowth,
    minProfileSamples: calibration.limits.minProfileSamples,
  },
  softReportThresholds: {
    medianNsPerOpByScenario: calibration.medianNsPerOpReportThresholds,
  },
  softLatencyReports,
  scenarios: gateResults,
};

await Bun.write(Bun.stdout, `${JSON.stringify(lastRun)}\n`);
if (shouldWriteResult) {
  await writeHotPathGateLastRun(PERFORMANCE_RESULT_PATH, lastRun);
  console.error(`hot-path gate: recorded this run into ${PERFORMANCE_RESULT_PATH}`);
}

cleanupGateFixture();
process.off("exit", cleanupGateFixture);
