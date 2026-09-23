/**
 * 各性能基准共用的统计原语。
 *
 * `hotPaths.ts` 与 `joinLog.ts` 用它取中位数，`identityDatabase/measurement.ts`
 * 与 `fullSuite/aggregate.ts` 用它取平均值和标准差。
 */

/** 算术平均值；调用方保证输入非空。 */
export function mean(values: readonly number[]): number {
  let sum: number = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** 总体标准差（除以 n，不是 n-1）；`average` 由调用方先算好，避免重复遍历。 */
export function standardDeviation(
  values: readonly number[],
  average: number
): number {
  let squaredDifferenceSum: number = 0;
  for (const value of values) {
    const difference: number = value - average;
    squaredDifferenceSum += difference * difference;
  }
  return Math.sqrt(squaredDifferenceSum / values.length);
}

/**
 * 中位数；偶数个样本取偏大的那一个，不做插值。
 *
 * 输入为空时返回 NaN。
 */
export function median(values: readonly number[]): number {
  const sorted: number[] = [...values].sort(
    (left: number, right: number): number => left - right
  );
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/** 已升序样本的分位数，取「最近秩」，不做插值。 */
export function percentile(
  sortedAscending: readonly number[],
  percentileRank: number
): number {
  if (sortedAscending.length === 0) {
    throw new Error("Latency percentile requires at least one sample.");
  }
  const rank: number = Math.ceil(percentileRank / 100 * sortedAscending.length);
  const index: number = Math.min(
    sortedAscending.length - 1,
    Math.max(0, rank - 1)
  );
  return sortedAscending[index]!;
}
