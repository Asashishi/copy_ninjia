/**
 * 各性能基准共用的统计原语。
 *
 * 单独成文件是因为四个基准入口都要算同一批数：`hotPaths.ts` 与 `joinLog.ts`
 * 取中位数，`identityDatabase/measurement.ts` 与 `fullSuite/aggregate.ts` 取
 * 平均值和标准差。各自留一份实现的代价不是重复几行代码，而是「同一个字段名
 * 在两份报告里其实按不同口径算出来」——那种偏差没有任何门禁看得见。
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
 * 用它而不是平均值，是为了让偶发调度抖动和一次 GC 不至于把整轮读数拉走。
 * 输入为空时返回 NaN——那只可能是采样数配成了 0，让它显式地脏掉，
 * 而不是伪装成一个 0 ns/op。
 */
export function median(values: readonly number[]): number {
  const sorted: number[] = [...values].sort(
    (left: number, right: number): number => left - right
  );
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

/**
 * 已升序样本的分位数。
 *
 * 取「最近秩」而不是插值：链路延迟按千计而不是按百万计，插值出来的 p99 会落在
 * 两次真实往返之间，读起来像是观测到过那个值，其实没有。
 */
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
