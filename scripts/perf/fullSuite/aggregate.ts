/**
 * 轮次聚合。
 *
 * 三轮取平均是本基准的对外口径，但只报平均值会掩盖调度抖动，因此每项指标
 * 同时给出最小值、最大值和变异系数：CV 明显变大时，那一行的平均值就不该
 * 再拿去和历史比。
 */

import { mean, standardDeviation } from "../statistics";
import type { MetricStats, MetricUnit } from "./types";

/** 一项待聚合指标的取值器。 */
export interface MetricDefinition<TRound> {
  readonly metric: string;
  readonly unit: MetricUnit;
  readonly select: (round: TRound) => number;
}

/** 把一项指标在各轮上的取值聚合成一行读数。 */
export function aggregateMetric(
  metric: string,
  unit: MetricUnit,
  values: readonly number[]
): MetricStats {
  if (values.length === 0) {
    throw new Error(`Metric ${metric} has no samples to aggregate.`);
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`Metric ${metric} produced a non-finite sample.`);
    }
  }
  const average: number = mean(values);
  return {
    metric,
    unit,
    samples: values.length,
    mean: average,
    min: Math.min(...values),
    max: Math.max(...values),
    coefficientOfVariationPercent: average === 0
      ? 0
      : standardDeviation(values, average) * 100 / Math.abs(average),
  };
}

/** 按定义表把同一被测对象的各轮读数聚合成整行指标。 */
export function aggregateRounds<TRound>(
  rounds: readonly TRound[],
  definitions: readonly MetricDefinition<TRound>[]
): readonly MetricStats[] {
  return definitions.map((definition: MetricDefinition<TRound>): MetricStats =>
    aggregateMetric(
      definition.metric,
      definition.unit,
      rounds.map(definition.select)
    )
  );
}
