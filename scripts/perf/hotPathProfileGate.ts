/**
 * 固定 Bun、固定场景、独立进程重复的热路径内存/GC/JIT 门禁。
 *
 * 每个场景分别运行 sampling-profile 与 retained 子进程：前者只判断正式循环的
 * GC/JIT，后者在没有 profiler 自身内存干扰时判断 RSS、heapUsed 波峰与 full-GC
 * 后留存；retained 中位 ns/op 只按逐场景阈值软上报，不让合法慢操作误伤门禁。
 * 脚本串行运行，避免场景之间争抢资源。
 *
 * 阈值与 Bun 锚点全部来自仓库根被跟踪的 `performance-result.json`（见
 * `scripts/perf/hotPaths/gateResult.ts`），不再写死在 TypeScript 里。带
 * `--write-result` 运行时，本次读数覆盖写回同一份文件的 `lastRun`；不带这个
 * 开关就只读不写，`bun run check` 因此不会弄脏工作树。
 */

import { join } from "node:path";
import { isPlainRecord } from "../../packages/libs/record";
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
import { PERFORMANCE_RESULT_PATH } from "./performanceResult";

/** 仓库根；场景子进程按它定位。 */
const projectRoot: string = join(import.meta.dir, "../..");

/**
 * 校准记录在任何子进程启动之前读一次并严格校验。放在这里而不是首次用到时才读：
 * 记录写坏时不该先花十几分钟跑完九个场景再报错。
 */
const calibration: HotPathGateCalibration = readHotPathGateCalibration(PERFORMANCE_RESULT_PATH);

/**
 * 只有显式传 `--write-result` 才把本次读数写回 `lastRun`。默认只读，
 * `bun run check` 因此不会因为跑了一次门禁就产生工作树改动。
 */
const shouldWriteResult: boolean = process.argv.includes("--write-result");

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
  readonly retainedHeapDelta: number | null;
  readonly retainedExtraMemoryDelta: number | null;
  readonly retainedObjectDelta: number | null;
  readonly peakSampledHeapUsedDelta: number;
  readonly peakSampledRssBytes: number;
  readonly processPeakRssBytes: number;
  readonly samplingProfile: SamplingProfileResult | null;
  readonly jit: Readonly<Record<string, JitProbeResult>>;
}

/**
 * 单场景的汇总读数。字段名标明来源与效力：`...Diagnostic` 后缀表示只输出、不设闸门，
 * 其余每一项都有 assert*WithinLimits 里的对应断言；`profile`/`retained` 前缀标明取自
 * 哪个子进程，两者的预热轮数差一个数量级（profiler 场景要多跑 JIT 稳定轮），混在
 * 同一行会让读数无法解释。
 */
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
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `Hot-path child omitted finite number or null field ${key}.`
    );
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
    retainedHeapDelta: requiredNullableNumber(parsed, "retainedHeapDelta"),
    retainedExtraMemoryDelta: requiredNullableNumber(
      parsed,
      "retainedExtraMemoryDelta"
    ),
    retainedObjectDelta: requiredNullableNumber(parsed, "retainedObjectDelta"),
    peakSampledHeapUsedDelta: requiredNumber(
      parsed,
      "peakSampledHeapUsedDelta"
    ),
    peakSampledRssBytes: requiredNumber(parsed, "peakSampledRssBytes"),
    processPeakRssBytes: requiredNumber(parsed, "processPeakRssBytes"),
    samplingProfile: parsed.samplingProfile === null
      ? null
      : parseSamplingProfile(parsed.samplingProfile),
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

function assertRuntimeMatches(result: ChildProfileResult): void {
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
  if (
    !Number.isSafeInteger(result.warmupIterations) ||
    result.warmupIterations <= 0
  ) {
    throw new Error(`${result.scenario}: child returned invalid warmup iterations.`);
  }
  if (result.medianNsPerOp <= 0) {
    throw new Error(`${result.scenario}: child returned invalid median latency.`);
  }
}

function assertProfileRunWithinLimits(result: ChildProfileResult): void {
  assertRuntimeMatches(result);
  if (result.measurementMode !== "steadyProfile" || result.samplingProfile === null) {
    throw new Error(`${result.scenario}: child did not return a sampling profile.`);
  }
  const samplingProfile: SamplingProfileResult = result.samplingProfile;
  if (samplingProfile.totalSamples < calibration.limits.minProfileSamples) {
    throw new Error(
      `${result.scenario}: only ${samplingProfile.totalSamples} profile samples; ` +
      `expected at least ${calibration.limits.minProfileSamples}.`
    );
  }
  if (samplingProfile.gcPercent > calibration.limits.maxGcPercent) {
    throw new Error(
      `${result.scenario}: GC used ${samplingProfile.gcPercent.toFixed(3)}% of ` +
      `steady samples; limit is ${calibration.limits.maxGcPercent}%.`
    );
  }
  // 汇总 FTL 比例只作诊断（输出字段名带 Diagnostic 后缀），异步场景会混入 native
  // Promise/调度采样，不能代表内部生产函数的 JIT 层级：Bun 1.3.14 实测
  // mention-facts-plain（纯叶子）97.98%、incoming-message-spine（异步主链）3.17%，
  // 单一阈值对两类场景没有共同含义，按场景标定又等于把噪声写死成契约。
  //
  // reoptRetries 的绝对值同样只作诊断：hotPaths.ts 的 productionJitTiersAreStable
  // 已经要求它连续两个完整轮次不变才开始采样，采样期再由 changedDuringSampling
  // 复查，因此这个计数剩下的只是预热期历史。实测 6 个场景里 5 个恒为 0，
  // flood-window-steady 的 observeMemberMessage 稳定为 1（dfgCompiles=2，预热期
  // 被去优化过一次又重编译），对它设硬上限只会逼出一张按场景标定的阈值表。
  //
  // 稳态 JIT 闸门因此就是下面这两条逐生产探针的判据。
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

function assertRetainedRunWithinLimits(result: ChildProfileResult): void {
  assertRuntimeMatches(result);
  if (
    result.measurementMode !== "retained" ||
    result.samplingProfile !== null ||
    result.retainedHeapDelta === null ||
    result.retainedExtraMemoryDelta === null ||
    result.retainedObjectDelta === null
  ) {
    throw new Error(`${result.scenario}: child did not return retained-memory results.`);
  }
  if (result.peakSampledRssBytes > calibration.limits.maxRssBytes) {
    throw new Error(
      `${result.scenario}: sampled RSS peaked at ${result.peakSampledRssBytes} bytes; ` +
      `limit is ${calibration.limits.maxRssBytes}.`
    );
  }
  // 逐节拍采样只看得见节拍那一刻的 RSS；完整落在两次节拍之间的瞬时大块分配要靠
  // 进程生命周期高水位才拦得住，两者共用同一个上限。
  if (result.processPeakRssBytes > calibration.limits.maxRssBytes) {
    throw new Error(
      `${result.scenario}: process peak RSS reached ${result.processPeakRssBytes} bytes; ` +
      `limit is ${calibration.limits.maxRssBytes}.`
    );
  }
  if (
    result.peakSampledHeapUsedDelta >
      calibration.limits.maxSampledHeapGrowthBytes
  ) {
    throw new Error(
      `${result.scenario}: sampled heapUsed grew by ${result.peakSampledHeapUsedDelta} bytes; ` +
      `limit is ${calibration.limits.maxSampledHeapGrowthBytes}.`
    );
  }
  if (result.retainedHeapDelta > calibration.limits.maxRetainedHeapGrowthBytes) {
    throw new Error(
      `${result.scenario}: retained JSC heap grew by ${result.retainedHeapDelta} bytes; ` +
      `limit is ${calibration.limits.maxRetainedHeapGrowthBytes}.`
    );
  }
  if (
    result.retainedExtraMemoryDelta >
      calibration.limits.maxRetainedExtraMemoryGrowthBytes
  ) {
    throw new Error(
      `${result.scenario}: retained extra memory grew by ` +
      `${result.retainedExtraMemoryDelta} bytes; limit is ` +
      `${calibration.limits.maxRetainedExtraMemoryGrowthBytes}.`
    );
  }
  if (result.retainedObjectDelta > calibration.limits.maxRetainedObjectGrowth) {
    throw new Error(
      `${result.scenario}: retained object count grew by ${result.retainedObjectDelta}; ` +
      `limit is ${calibration.limits.maxRetainedObjectGrowth}.`
    );
  }
}

async function runChild(
  projectRoot: string,
  scenario: string,
  measurementMode: "retained" | "steadyProfile"
): Promise<ChildProfileResult> {
  const args: string[] = [
    process.execPath,
    join(projectRoot, "scripts/perf/hotPaths.ts"),
    scenario,
  ];
  if (measurementMode === "steadyProfile") args.push("--profile");
  const subprocess: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
    args,
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
  if (measurementMode === "steadyProfile") {
    assertProfileRunWithinLimits(result);
  } else {
    assertRetainedRunWithinLimits(result);
  }
  return result;
}

function maximum(values: readonly number[]): number {
  return Math.max(...values);
}

function minimum(values: readonly number[]): number {
  return Math.min(...values);
}

const gateResults: ScenarioGateResult[] = [];
const softLatencyReports: HotPathMedianLatencyReport[] = [];
let expectedBunVersion: string | undefined;
let expectedBunRevision: string | undefined;

// 阈值契约只在这里判一次；返回的表按场景顺序，下面直接连阈值一起遍历。
const medianLatencyPolicy: ReadonlyMap<string, number> =
  assertHotPathMedianPolicyCoverage(
    HOT_PATH_PROFILE_SCENARIOS,
    calibration.medianNsPerOpReportThresholds
  );

for (const [scenario, reportThresholdNsPerOp] of medianLatencyPolicy) {
  const profileRuns: ChildProfileResult[] = [];
  const retainedRuns: ChildProfileResult[] = [];
  for (let repeat: number = 0; repeat < HOT_PATH_PROFILE_REPEATS; repeat++) {
    const profileRun: ChildProfileResult = await runChild(
      projectRoot,
      scenario,
      "steadyProfile"
    );
    const retainedRun: ChildProfileResult = await runChild(
      projectRoot,
      scenario,
      "retained"
    );
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

// 软上报要有自己的一行。埋在下面那个 JSON 里等于没报：`bun run check` 照常
// exit 0、输出里也看不出差别，一次 218 -> 400 ns/op 的退化除非有人专门去 grep
// 那个 blob，否则不会有任何人发现。仍然不改退出码——这七个阈值是校准值不是
// 硬门禁，硬指标由上面的 GC/RSS/常驻增长几道判定负责。
for (const report of softLatencyReports) {
  process.stderr.write(
    `hot-path soft latency: ${report.scenario} median ${report.medianNsPerOp.toFixed(1)} ns/op ` +
    `exceeds its ${report.reportThresholdNsPerOp} ns/op policy by ` +
    `${report.overrunNsPerOp.toFixed(1)} ns/op (+${report.overrunPercent.toFixed(1)}%) ` +
    `on Bun ${expectedBunRevision}.\n`
  );
}

/**
 * 本次门禁的完整读数。stdout 与 performance-result.json 的 `lastRun` 是同一个对象，不各写
 * 一份：两份形状迟早会分叉，而分叉之后「我看到的那个 JSON」到底来自哪里就说
 * 不清了。`thresholds` 一并带上，让一份记录自己就能解释判据是什么。
 */
const lastRun: Readonly<Record<string, unknown>> = {
  recordedAt: new Date().toISOString(),
  bunVersion: expectedBunVersion,
  bunRevision: expectedBunRevision,
  thresholds: {
    maxGcPercent: calibration.limits.maxGcPercent,
    maxSampledRssBytes: calibration.limits.maxRssBytes,
    maxProcessPeakRssBytes: calibration.limits.maxRssBytes,
    maxSampledHeapUsedGrowthBytes:
      calibration.limits.maxSampledHeapGrowthBytes,
    maxRetainedHeapGrowthBytes:
      calibration.limits.maxRetainedHeapGrowthBytes,
    maxRetainedExtraMemoryGrowthBytes:
      calibration.limits.maxRetainedExtraMemoryGrowthBytes,
    maxRetainedObjectGrowth:
      calibration.limits.maxRetainedObjectGrowth,
    minProfileSamples: calibration.limits.minProfileSamples,
  },
  softReportThresholds: {
    medianNsPerOpByScenario:
      calibration.medianNsPerOpReportThresholds,
  },
  softLatencyReports,
  scenarios: gateResults,
};

process.stdout.write(`${JSON.stringify(lastRun)}\n`);

// 回写只覆盖 lastRun。`calibration` 那一半是人重标出来的判据，绝不由一次运行
// 的读数自动改写——那等于把闸门焊死在当前性能上，退化会连同阈值一起被记下来。
if (shouldWriteResult) {
  writeHotPathGateLastRun(PERFORMANCE_RESULT_PATH, lastRun);
  process.stderr.write(`hot-path gate: recorded this run into ${PERFORMANCE_RESULT_PATH}\n`);
}
