/** 热路径 GC 预算选择与纳秒软上报的纯判定。 */
import { HOT_PATH_GC_CPU_BUDGETS } from "../../../packages/consts/performance";

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
 * 阈值合法性**不在这里判**：调用方跑一次 assertHotPathMedianPolicyCoverage 就
 * 拿到了一张证明过的表，两处各判一次只会让将来改阈值形状时要同步改两个地方
 * 才自洽，而其中一处的失败分支根本没有生产调用方到得了。
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

/**
 * 默认场景与阈值表必须一一对应，禁止新场景漏报或死阈值滞留。
 *
 * @returns 场景 -> 已校验阈值，按场景声明顺序。门禁直接遍历它，就不必再拿
 *   场景名回表查一次，也就没有第二处「阈值可能缺失」的分支要交代。
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
