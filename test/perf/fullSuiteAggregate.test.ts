import { describe, expect, test } from "bun:test";
import {
  aggregateMetric,
  aggregateRounds,
} from "../../scripts/perf/fullSuite/aggregate";
import {
  mean,
  median,
  percentile,
  standardDeviation,
} from "../../scripts/perf/statistics";
import type { MetricDefinition } from "../../scripts/perf/fullSuite/aggregate";
import type { MetricStats } from "../../scripts/perf/fullSuite/types";

interface Round {
  readonly elapsedMs: number;
  readonly bytes: number;
}

describe("全量基准的轮次聚合", () => {
  test("给出平均值、最小值、最大值与变异系数", () => {
    expect(aggregateMetric("duration", "ms", [10, 12, 14])).toEqual({
      metric: "duration",
      unit: "ms",
      samples: 3,
      mean: 12,
      min: 10,
      max: 14,
      coefficientOfVariationPercent: Math.sqrt(8 / 3) * 100 / 12,
    });
  });

  test("平均值为 0 时变异系数按 0 报，不产生 NaN", () => {
    const stats: MetricStats = aggregateMetric("writtenBytes", "bytes", [0, 0]);
    expect(stats.mean).toBe(0);
    expect(stats.coefficientOfVariationPercent).toBe(0);
  });

  test("样本均值为负时变异系数仍保持非负", () => {
    const stats: MetricStats = aggregateMetric("retainedHeap", "bytes", [-10, -12, -14]);
    expect(stats.mean).toBe(-12);
    expect(stats.coefficientOfVariationPercent).toBe(
      Math.sqrt(8 / 3) * 100 / 12
    );
  });

  test("没有样本或出现非有限值时拒绝聚合", () => {
    expect((): unknown => aggregateMetric("duration", "ms", []))
      .toThrow("has no samples to aggregate");
    expect((): unknown => aggregateMetric("duration", "ms", [1, Number.NaN]))
      .toThrow("produced a non-finite sample");
    expect((): unknown => aggregateMetric("duration", "ms", [Number.POSITIVE_INFINITY]))
      .toThrow("produced a non-finite sample");
  });

  test("按定义表聚合，保持定义顺序与单位", () => {
    const definitions: readonly MetricDefinition<Round>[] = [
      {
        metric: "elapsed",
        unit: "ms",
        select: (round: Round): number => round.elapsedMs,
      },
      {
        metric: "written",
        unit: "bytes",
        select: (round: Round): number => round.bytes,
      },
    ];
    const metrics: readonly MetricStats[] = aggregateRounds(
      [{ elapsedMs: 2, bytes: 100 }, { elapsedMs: 4, bytes: 300 }],
      definitions
    );
    expect(metrics.map((metric: MetricStats): string => metric.metric))
      .toEqual(["elapsed", "written"]);
    expect(metrics[0]!.mean).toBe(3);
    expect(metrics[1]!.unit).toBe("bytes");
    expect(metrics[1]!.max).toBe(300);
  });
});

describe("共用统计原语", () => {
  test("平均值与总体标准差", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(standardDeviation([2, 4, 6], 4)).toBeCloseTo(Math.sqrt(8 / 3), 12);
  });

  test("中位数取偏大的那一个，空输入显式返回 NaN", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe("链路延迟分位数", () => {
  test("取最近秩，不在两次真实往返之间插值", () => {
    const sorted: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile(sorted, 99)).toBe(10);
  });

  test("单个样本时各分位数都是它自己", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });

  test("没有样本时拒绝给出分位数", () => {
    expect((): unknown => percentile([], 50))
      .toThrow("requires at least one sample");
  });
});
