import { describe, expect, test } from "bun:test";
import {
  HOT_PATH_CALIBRATION_STALE_RATIO,
  HOT_PATH_GC_CPU_BUDGETS,
  HOT_PATH_GC_SOFT_OVERRUN_PERCENT,
} from "../../packages/consts/performance";
import type { HotPathGcCpuBudget } from "../../packages/types/performance";
import {
  assertHotPathMedianPolicyCoverage,
  createHotPathCalibrationStaleReport,
  createHotPathGcSoftReport,
  createHotPathMedianLatencyReport,
  hotPathGcPauseFailPercent,
  selectHotPathGcPausePercentLimit,
} from "../../scripts/perf/hotPaths/gateLimits";

describe("热路径 GC 按可用 CPU 数分档", () => {
  test.each(HOT_PATH_GC_CPU_BUDGETS.map((budget: HotPathGcCpuBudget): [HotPathGcCpuBudget] => [budget]))(
    "分档下界 %o 使用该档暂停预算，直到下一档下界之前不变",
    (budget: HotPathGcCpuBudget): void => {
      expect(selectHotPathGcPausePercentLimit(budget.minCpuCount)).toBe(budget.maxPausePercent);
      const higher: number[] = HOT_PATH_GC_CPU_BUDGETS
        .map((candidate: HotPathGcCpuBudget): number => candidate.minCpuCount)
        .filter((minCpuCount: number): boolean => minCpuCount > budget.minCpuCount);
      const nextFloor: number = higher.length === 0 ? budget.minCpuCount * 32 : Math.min(...higher);
      expect(selectHotPathGcPausePercentLimit(nextFloor - 1)).toBe(budget.maxPausePercent);
    }
  );

  test("CPU 越多预算越紧，不随 CPU 数增加而放宽", (): void => {
    let previous: number = Number.POSITIVE_INFINITY;
    for (let cpuCount: number = 1; cpuCount <= 128; cpuCount++) {
      const limit: number = selectHotPathGcPausePercentLimit(cpuCount);
      expect(limit).toBeLessThanOrEqual(previous);
      previous = limit;
    }
  });

  test.each([0, -1, 1.5, NaN, Infinity])("非法 CPU 数拒绝分档：%#", (cpuCount: number): void => {
    expect((): number => selectHotPathGcPausePercentLimit(cpuCount))
      .toThrow("positive integer CPU count");
  });
});

describe("热路径 GC 软超限", () => {
  test("硬上限是 CPU 分档预算加 HOT_PATH_GC_SOFT_OVERRUN_PERCENT 个百分点", (): void => {
    for (const budget of HOT_PATH_GC_CPU_BUDGETS) {
      expect(hotPathGcPauseFailPercent(selectHotPathGcPausePercentLimit(budget.minCpuCount)))
        .toBe(budget.maxPausePercent + HOT_PATH_GC_SOFT_OVERRUN_PERCENT);
    }
  });

  test("不超过预算时没有报告，超过预算时返回预算与硬上限但不抛错", (): void => {
    expect(createHotPathGcSoftReport({ scenario: "steady", gcPercent: 25, budgetPercent: 25 })).toBeNull();
    expect(createHotPathGcSoftReport({ scenario: "steady", gcPercent: 25.5, budgetPercent: 25 })).toEqual({
      scenario: "steady",
      gcPercent: 25.5,
      budgetPercent: 25,
      failPercent: 30,
    });
  });
});

describe("热路径纳秒软上报", () => {
  test("不超过阈值时没有报告，超过时返回完整超额内容但不抛错", () => {
    expect(createHotPathMedianLatencyReport({
      scenario: "steady",
      medianNsPerOp: 25,
      bunRevision: "revision-test",
      reportThresholdNsPerOp: 25,
    })).toBeNull();
    expect(createHotPathMedianLatencyReport({
      scenario: "steady",
      medianNsPerOp: 30,
      bunRevision: "revision-test",
      reportThresholdNsPerOp: 25,
    })).toEqual({
      scenario: "steady",
      medianNsPerOp: 30,
      reportThresholdNsPerOp: 25,
      overrunNsPerOp: 5,
      overrunPercent: 20,
      bunRevision: "revision-test",
    });
  });

  test("默认场景与阈值表必须精确覆盖", () => {
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one", "two"],
      { one: 1, two: 2 }
    )).not.toThrow();
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one", "two"],
      { one: 1 }
    )).toThrow("two has no positive median policy");
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one"],
      { one: 1, stale: 2 }
    )).toThrow("stale has no default scenario");
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one", "one"],
      { one: 1 }
    )).toThrow("one is duplicated");
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one"],
      { one: 0 }
    )).toThrow("one has no positive median policy");
  });

  test("校验通过后交回场景 -> 阈值表，门禁不必再回表查一次", () => {
    // 阈值契约只有这一个 owner：createHotPathMedianLatencyReport 直接吃这里给出的
    // 数，两处各判一次会让将来改阈值形状必须同步改两个地方才自洽。
    const policy: ReadonlyMap<string, number> = assertHotPathMedianPolicyCoverage(
      ["first", "second"],
      { first: 10, second: 20 }
    );

    expect([...policy]).toEqual([["first", 10], ["second", 20]]);
  });
});

describe("热路径校准过松提示", () => {
  const input = { scenario: "steady", bunRevision: "rev", reportThresholdNsPerOp: 300 };

  test("阈值超过本次读数的倍数上限时提示重校，并给出余量倍数", () => {
    expect(createHotPathCalibrationStaleReport({ ...input, medianNsPerOp: 50 })).toEqual({
      scenario: "steady",
      medianNsPerOp: 50,
      reportThresholdNsPerOp: 300,
      headroomRatio: 6,
    });
  });

  test("恰好等于倍数上限或余量更小时不提示", () => {
    expect(createHotPathCalibrationStaleReport({
      ...input,
      medianNsPerOp: 300 / HOT_PATH_CALIBRATION_STALE_RATIO,
    })).toBeNull();
    expect(createHotPathCalibrationStaleReport({ ...input, medianNsPerOp: 200 })).toBeNull();
  });
});
