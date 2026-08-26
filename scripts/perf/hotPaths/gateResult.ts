/**
 * 仓库根 `performance-result.json` 的唯一严格解析与回写边界。
 *
 * 热路径门禁的**校准记录**（Bun 版本/revision、内存与 GC 硬上限、逐场景 ns/op
 * 软阈值，以及每个数字背后的实测读数）不写进 TypeScript：它们是随运行时重测
 * 而变的观测值，不是代码常量。`packages/consts/performance.ts` 因此只留与测量
 * 无关的采样旋钮（采样间隔、重复次数、JIT 稳定轮数、场景表）。
 *
 * 方向是双向的，但两半的 owner 不同，不能混：
 * - `calibration` 由人重标后手工修改，门禁只读。回写路径一个字节都不碰它——
 *   阈值只能在空载机器上多进程重测后调整（见 performance-result.json 的 notes），让门禁
 *   拿一次运行的读数自动改自己的判据，等于把闸门焊死在当前性能上。
 * - `lastRun` 由 `bun run perf:hot-path-gate --write-result` 覆盖写，记录最近
 *   一次门禁的读数。不传 `--write-result` 时门禁绝不写盘，`bun run check`
 *   因此不会弄脏工作树。
 *
 * 解析一律 fail-fast：未知键、缺字段、类型不符、取值越界都抛错并点明字段路径，
 * 不做默认值回填、不丢弃非法条目（见 AGENTS.md 的「不为用户行为兜底」）。
 */

import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../../../packages/libs/record";
import { writePerformanceResultEntry } from "../performanceResult";

/** 校准时使用的 Bun 运行时；同版本不同构建也会混测，两项都要对上。 */
export interface HotPathGateRuntimeCalibration {
  readonly bunVersion: string;
  readonly bunRevision: string;
}

/** 门禁的硬上限；每一项都有 hotPathProfileGate.ts 里对应的 assert 分支。 */
export interface HotPathGateLimits {
  readonly minProfileSamples: number;
  readonly maxGcPercent: number;
  readonly maxRssBytes: number;
  readonly maxSampledHeapGrowthBytes: number;
  readonly maxRetainedHeapGrowthBytes: number;
  readonly maxRetainedExtraMemoryGrowthBytes: number;
  readonly maxRetainedObjectGrowth: number;
}

/**
 * 单个场景的软上报阈值及其来源读数。
 *
 * 不导出、也不进解析结果：门禁只消费下面派生出的阈值表，`measured` 的作用是让
 * 「阈值必须解释得了它自己」这条校验在解析期就能做（见 parseScenario）。把整张
 * 表再挂到返回值上，只会多一份没有生产消费者的出口。
 */
interface HotPathGateScenarioCalibration {
  readonly medianNsPerOpReportThreshold: number;
  readonly slowestMedianNsPerOp: number;
  readonly processes: number;
}

/** performance-result.json 中门禁只读的那一半。 */
export interface HotPathGateCalibration {
  readonly runtime: HotPathGateRuntimeCalibration;
  readonly limits: HotPathGateLimits;
  /** 场景 -> 软上报阈值，直接喂给 assertHotPathMedianPolicyCoverage。 */
  readonly medianNsPerOpReportThresholds: Readonly<Record<string, number>>;
}

/** `limits` 中要求为正数的字段，按 performance-result.json 的声明顺序。 */
const LIMIT_KEYS: readonly (keyof HotPathGateLimits)[] = [
  "minProfileSamples",
  "maxGcPercent",
  "maxRssBytes",
  "maxSampledHeapGrowthBytes",
  "maxRetainedHeapGrowthBytes",
  "maxRetainedExtraMemoryGrowthBytes",
  "maxRetainedObjectGrowth",
];

/** 供人阅读的说明字段；结构上允许存在，但门禁不消费其内容。 */
const NOTES_KEY: string = "notes";

/**
 * 顶层允许出现的节。`fullSuite` 由全量基准（`bun run perf:full -- --write-doc`）
 * 写入，门禁既不读也不写它，但必须容忍它存在——否则同一份记录文件里多一节，
 * 热路径门禁就会整份拒绝解析。
 */
const TOP_LEVEL_SECTIONS: readonly string[] = ["hotPathProfileGate", "fullSuite"];

/**
 * 抛出点名字段路径的解析失败。这里只写字段路径，文件路径由 read/write 入口统一
 * 补在前面——校验函数不该各自记住自己在读哪个文件，那样迟早会有一处写错。
 */
function fail(path: string, expectation: string): never {
  throw new Error(`$.${path} ${expectation}; fix the calibration record before running the gate.`);
}

function requiredRecord(
  parent: Readonly<Record<string, unknown>>,
  key: string,
  path: string
): Record<string, unknown> {
  const value: unknown = parent[key];
  if (!isPlainRecord(value)) fail(path, "must be an object");
  return value;
}

function requiredNonEmptyString(
  parent: Readonly<Record<string, unknown>>,
  key: string,
  path: string
): string {
  const value: unknown = parent[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

function requiredPositiveNumber(
  parent: Readonly<Record<string, unknown>>,
  key: string,
  path: string
): number {
  const value: unknown = parent[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(path, "must be a finite number greater than 0");
  }
  return value;
}

/** 键集合精确闭集；多一个未知键就说明记录与解析边界已经脱节。 */
function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  path: string
): void {
  if (!hasExactKeys(value, keys)) {
    fail(path, `must declare exactly these keys: ${keys.join(", ")}`);
  }
}

function parseRuntime(
  gate: Readonly<Record<string, unknown>>
): HotPathGateRuntimeCalibration {
  const runtime: Record<string, unknown> = requiredRecord(
    gate,
    "runtime",
    "hotPathProfileGate.calibration.runtime"
  );
  assertExactKeys(
    runtime,
    ["bunVersion", "bunRevision", NOTES_KEY],
    "hotPathProfileGate.calibration.runtime"
  );
  return {
    bunVersion: requiredNonEmptyString(
      runtime,
      "bunVersion",
      "hotPathProfileGate.calibration.runtime.bunVersion"
    ),
    bunRevision: requiredNonEmptyString(
      runtime,
      "bunRevision",
      "hotPathProfileGate.calibration.runtime.bunRevision"
    ),
  };
}

function parseLimits(gate: Readonly<Record<string, unknown>>): HotPathGateLimits {
  const limits: Record<string, unknown> = requiredRecord(
    gate,
    "limits",
    "hotPathProfileGate.calibration.limits"
  );
  assertExactKeys(
    limits,
    [...LIMIT_KEYS, NOTES_KEY],
    "hotPathProfileGate.calibration.limits"
  );
  // 逐字段显式取值而不是循环装配后强转：LIMIT_KEYS 只用来锁死键集合闭包，
  // 字段类型仍由 HotPathGateLimits 在编译期保证，将来加一项会在这里编译报错，
  // 而不是悄悄产出一个少一个字段的对象。
  return {
    minProfileSamples: requiredPositiveNumber(
      limits, "minProfileSamples", "hotPathProfileGate.calibration.limits.minProfileSamples"
    ),
    maxGcPercent: requiredPositiveNumber(
      limits, "maxGcPercent", "hotPathProfileGate.calibration.limits.maxGcPercent"
    ),
    maxRssBytes: requiredPositiveNumber(
      limits, "maxRssBytes", "hotPathProfileGate.calibration.limits.maxRssBytes"
    ),
    maxSampledHeapGrowthBytes: requiredPositiveNumber(
      limits,
      "maxSampledHeapGrowthBytes",
      "hotPathProfileGate.calibration.limits.maxSampledHeapGrowthBytes"
    ),
    maxRetainedHeapGrowthBytes: requiredPositiveNumber(
      limits,
      "maxRetainedHeapGrowthBytes",
      "hotPathProfileGate.calibration.limits.maxRetainedHeapGrowthBytes"
    ),
    maxRetainedExtraMemoryGrowthBytes: requiredPositiveNumber(
      limits,
      "maxRetainedExtraMemoryGrowthBytes",
      "hotPathProfileGate.calibration.limits.maxRetainedExtraMemoryGrowthBytes"
    ),
    maxRetainedObjectGrowth: requiredPositiveNumber(
      limits,
      "maxRetainedObjectGrowth",
      "hotPathProfileGate.calibration.limits.maxRetainedObjectGrowth"
    ),
  };
}

function parseScenario(
  value: unknown,
  path: string
): HotPathGateScenarioCalibration {
  if (!isPlainRecord(value)) fail(path, "must be an object");
  assertExactKeys(
    value,
    ["medianNsPerOpReportThreshold", "measured", "note"],
    path
  );
  const measured: Record<string, unknown> = requiredRecord(
    value,
    "measured",
    `${path}.measured`
  );
  assertExactKeys(
    measured,
    ["slowestMedianNsPerOp", "processes"],
    `${path}.measured`
  );
  if (typeof value.note !== "string") fail(`${path}.note`, "must be a string");
  const processes: number = requiredPositiveNumber(
    measured,
    "processes",
    `${path}.measured.processes`
  );
  if (!Number.isSafeInteger(processes)) {
    fail(`${path}.measured.processes`, "must be a positive integer");
  }
  const threshold: number = requiredPositiveNumber(
    value,
    "medianNsPerOpReportThreshold",
    `${path}.medianNsPerOpReportThreshold`
  );
  const slowestMedianNsPerOp: number = requiredPositiveNumber(
    measured,
    "slowestMedianNsPerOp",
    `${path}.measured.slowestMedianNsPerOp`
  );
  // 阈值低于它自己的来源读数，说明这条记录在重标时只改了一半：门禁会从第一次
  // 运行起就稳定软报，而那正是「出现即异常」失效的样子。
  if (threshold < slowestMedianNsPerOp) {
    fail(
      `${path}.medianNsPerOpReportThreshold`,
      `must be at least its own measured.slowestMedianNsPerOp (${slowestMedianNsPerOp})`
    );
  }
  return { medianNsPerOpReportThreshold: threshold, slowestMedianNsPerOp, processes };
}

/**
 * 读取并严格校验 performance-result.json 的校准记录。
 *
 * 只校验结构与取值形态；「场景表是否与默认场景一一对应」仍由
 * assertHotPathMedianPolicyCoverage 判定，避免同一条契约有两个 owner。
 */
export async function readHotPathGateCalibration(
  path: string
): Promise<HotPathGateCalibration> {
  try {
    return parseCalibrationDocument(await readDocument(path));
  } catch (error: unknown) {
    const reason: string = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: ${reason}`, { cause: error });
  }
}

/** 严格 JSON 读取；解析失败即致命，不退回默认值也不尝试修复。 */
async function readDocument(path: string): Promise<unknown> {
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch (error: unknown) {
    throw new Error("could not be read as strict JSON.", { cause: error });
  }
}

function parseCalibrationDocument(parsed: unknown): HotPathGateCalibration {
  if (!isPlainRecord(parsed)) fail("", "must be a JSON object");
  if (!hasOnlyKeys(parsed, TOP_LEVEL_SECTIONS)) {
    fail("", `must declare only these keys: ${TOP_LEVEL_SECTIONS.join(", ")}`);
  }
  // hotPathProfileGate 的存在性由下面这行强制：门禁没有它就无从判定。
  const root: Record<string, unknown> = requiredRecord(
    parsed,
    "hotPathProfileGate",
    "hotPathProfileGate"
  );
  assertExactKeys(root, ["calibration", "lastRun"], "hotPathProfileGate");
  const calibration: Record<string, unknown> = requiredRecord(
    root,
    "calibration",
    "hotPathProfileGate.calibration"
  );
  assertExactKeys(
    calibration,
    ["runtime", "limits", "scenarios", NOTES_KEY],
    "hotPathProfileGate.calibration"
  );
  // 按声明顺序校验。runtime 与 limits 是常数级检查，排在逐场景循环之前才符合
  // 本模块「记录写坏时不该先做完一堆无用功再报错」的口径。
  const runtime: HotPathGateRuntimeCalibration = parseRuntime(calibration);
  const limits: HotPathGateLimits = parseLimits(calibration);
  const scenarios: Record<string, unknown> = requiredRecord(
    calibration,
    "scenarios",
    "hotPathProfileGate.calibration.scenarios"
  );
  const thresholds: Record<string, number> = {};
  for (const name of Object.keys(scenarios)) {
    const scenario: HotPathGateScenarioCalibration = parseScenario(
      scenarios[name],
      `hotPathProfileGate.calibration.scenarios.${name}`
    );
    thresholds[name] = scenario.medianNsPerOpReportThreshold;
  }
  if (Object.keys(thresholds).length === 0) {
    fail("hotPathProfileGate.calibration.scenarios", "must declare at least one scenario");
  }
  return { runtime, limits, medianNsPerOpReportThresholds: thresholds };
}

/**
 * 把最近一次门禁读数覆盖写进 `hotPathProfileGate.lastRun`。
 *
 * 实际写盘在 `scripts/perf/performanceResult.ts`（同一份文件还有全量基准那一节，
 * 两边共用「只换自己那一格」的语义）。这层只钉死本侧的节名与键名，免得调用点
 * 各自拼字符串——拼错不会报错，只会往记录里多长出一个没人读的键。
 */
export async function writeHotPathGateLastRun(
  path: string,
  lastRun: unknown
): Promise<void> {
  await writePerformanceResultEntry({
    path,
    section: "hotPathProfileGate",
    entry: "lastRun",
    value: lastRun,
  });
}
