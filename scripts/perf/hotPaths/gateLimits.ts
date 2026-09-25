/** 热路径 GC 预算选择、GC 与纳秒软上报的纯判定。 */
import {
  HOT_PATH_CALIBRATION_STALE_RATIO,
  HOT_PATH_GC_CPU_BUDGETS,
  HOT_PATH_GC_SOFT_OVERRUN_PERCENT,
} from "../../../packages/consts/performance";

/** 可用 CPU 数必须为正整数；按降序下界选择所有场景共同的暂停预算。 */
export function selectHotPathGcPausePercentLimit(cpuCount: number): number {
  if (!Number.isSafeInteger(cpuCount) || cpuCount < 1) {
    throw new Error("Hot-path GC policy requires a positive integer CPU count.");
  }
  for (const budget of HOT_PATH_GC_CPU_BUDGETS) {
    if (cpuCount >= budget.minCpuCount) return budget.maxPausePercent;
  }
  throw new Error("Hot-path GC policy does not cover the available CPU count.");
}

export interface HotPathGcSoftReportInput {
  readonly scenario: string;
  /** 场景各稳态进程中最大的 GC 暂停占比。 */
  readonly gcPercent: number;
  /** selectHotPathGcPausePercentLimit 选出的 CPU 分档预算。 */
  readonly budgetPercent: number;
}

export interface HotPathGcSoftReport {
  readonly scenario: string;
  readonly gcPercent: number;
  readonly budgetPercent: number;
  /** 判失败的硬上限：预算加 HOT_PATH_GC_SOFT_OVERRUN_PERCENT。 */
  readonly failPercent: number;
}

/** CPU 分档预算加软超限余量，单个稳态进程超过即判失败。 */
export function hotPathGcPauseFailPercent(budgetPercent: number): number {
  return budgetPercent + HOT_PATH_GC_SOFT_OVERRUN_PERCENT;
}

/** 占比超过预算时返回软上报内容，否则为 null；超过硬上限的进程已由子进程门禁判失败。 */
export function createHotPathGcSoftReport({
  scenario,
  gcPercent,
  budgetPercent,
}: HotPathGcSoftReportInput): HotPathGcSoftReport | null {
  if (gcPercent <= budgetPercent) return null;
  return { scenario, gcPercent, budgetPercent, failPercent: hotPathGcPauseFailPercent(budgetPercent) };
}

export interface HotPathMedianReportInput {
  readonly scenario: string;
  readonly medianNsPerOp: number;
  readonly bunRevision: string;
  /** 已经过 assertHotPathMedianPolicyCoverage 校验的正数阈值。 */
  readonly reportThresholdNsPerOp: number;
}

export interface HotPathMedianLatencyReport {
  readonly scenario: string;
  readonly medianNsPerOp: number;
  readonly reportThresholdNsPerOp: number;
  readonly overrunNsPerOp: number;
  readonly overrunPercent: number;
  readonly bunRevision: string;
}

/**
 * 超过校准值时返回软上报内容。
 *
 * 阈值合法性不在这里判：由调用方先跑 assertHotPathMedianPolicyCoverage 校验。
 */
export function createHotPathMedianLatencyReport({
  scenario,
  medianNsPerOp,
  bunRevision,
  reportThresholdNsPerOp,
}: HotPathMedianReportInput): HotPathMedianLatencyReport | null {
  if (medianNsPerOp <= reportThresholdNsPerOp) return null;
  const overrunNsPerOp: number = medianNsPerOp - reportThresholdNsPerOp;
  return {
    scenario,
    medianNsPerOp,
    reportThresholdNsPerOp,
    overrunNsPerOp,
    overrunPercent: (overrunNsPerOp / reportThresholdNsPerOp) * 100,
    bunRevision,
  };
}

export interface HotPathCalibrationStaleReport {
  readonly scenario: string;
  readonly medianNsPerOp: number;
  readonly reportThresholdNsPerOp: number;
  /** 软阈值与本次最慢中位数之比。 */
  readonly headroomRatio: number;
}

/**
 * 本次最慢中位数乘以 HOT_PATH_CALIBRATION_STALE_RATIO 仍小于软阈值时返回校准过松
 * 提示，否则为 null。阈值合法性由调用方先经 assertHotPathMedianPolicyCoverage 校验。
 */
export function createHotPathCalibrationStaleReport({
  scenario,
  medianNsPerOp,
  reportThresholdNsPerOp,
}: HotPathMedianReportInput): HotPathCalibrationStaleReport | null {
  if (medianNsPerOp * HOT_PATH_CALIBRATION_STALE_RATIO >= reportThresholdNsPerOp) return null;
  return {
    scenario,
    medianNsPerOp,
    reportThresholdNsPerOp,
    headroomRatio: reportThresholdNsPerOp / medianNsPerOp,
  };
}

/**
 * 默认场景与阈值表必须一一对应，禁止新场景漏报或死阈值滞留。
 *
 * @returns 场景 -> 已校验阈值，按场景声明顺序；门禁直接遍历，不再按场景名
 *   回表查询。
 */
export function assertHotPathMedianPolicyCoverage(
  scenarios: readonly string[],
  thresholds: Readonly<Record<string, number>>
): ReadonlyMap<string, number> {
  const configured: Map<string, number> = new Map<string, number>();
  for (const scenario of scenarios) {
    if (configured.has(scenario)) {
      throw new Error(`Hot-path profile scenario ${scenario} is duplicated.`);
    }
    const threshold: number | undefined = thresholds[scenario];
    if (threshold === undefined || !Number.isFinite(threshold) || threshold <= 0) {
      throw new Error(`Hot-path profile scenario ${scenario} has no positive median policy.`);
    }
    configured.set(scenario, threshold);
  }
  for (const scenario of Object.keys(thresholds)) {
    if (!configured.has(scenario)) {
      throw new Error(`Hot-path median policy ${scenario} has no default scenario.`);
    }
  }
  return configured;
}
