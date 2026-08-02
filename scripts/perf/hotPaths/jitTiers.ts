import { numberOfDFGCompiles, reoptimizationRetryCount } from "bun:jsc";
import type { JitProbe, JitTierCounts, JitTierStats, Scenario } from "./types";

/** JSC 分层计数的采集与做差；判读口径见 types.ts 上的 JitTierCounts/JitTierStats。 */

export function prototypeProbes<T extends object>(
  label: string,
  prototype: T,
  keys: readonly (keyof T & string)[]
): Readonly<Record<string, JitProbe>> {
  const probes: Record<string, JitProbe> = {};
  for (const key of keys) {
    probes[`${label}.${key}`] = prototype[key] as JitProbe;
  }
  return probes;
}

export /**
 * 读取各热函数此刻的分层计数。这两个数由 JSC 挂在函数的 executable 上累计，
 * 只增不减，也不随堆快照或 GC 归零，因此可以在不同时刻取两次做差。
 *
 * 固定包含 `scenario.run`——它是承载整个计时循环的闭包，若它自己都没进 DFG，
 * 本次 ns/op 量的就不是优化后的稳态，其余探针数值也不必细看。
 */
function collectJitTiers(scenario: Scenario): Record<string, JitTierCounts> {
  const tiers: Record<string, JitTierCounts> = {
    "scenario.run": {
      dfgCompiles: numberOfDFGCompiles(scenario.run),
      reoptRetries: reoptimizationRetryCount(scenario.run),
    },
  };
  for (const [name, probe] of Object.entries(scenario.probes ?? {})) {
    tiers[name] = {
      dfgCompiles: numberOfDFGCompiles(probe),
      reoptRetries: reoptimizationRetryCount(probe),
    };
  }
  return tiers;
}

/**
 * 用预热后与采样后两份计数得出最终分层结果。计数只增不减，因此任一项变大都
 * 说明该函数在计时窗口内又被编译或去优化过一次，这次 ns/op 不是纯稳态读数。
 */
export function diffJitTiers(
  afterWarmup: Readonly<Record<string, JitTierCounts>>,
  afterSampling: Readonly<Record<string, JitTierCounts>>
): Record<string, JitTierStats> {
  const stats: Record<string, JitTierStats> = {};
  for (const [name, sampled] of Object.entries(afterSampling)) {
    const warmed: JitTierCounts | undefined = afterWarmup[name];
    stats[name] = {
      dfgCompiles: sampled.dfgCompiles,
      reoptRetries: sampled.reoptRetries,
      changedDuringSampling:
        warmed === undefined ||
        sampled.dfgCompiles > warmed.dfgCompiles ||
        sampled.reoptRetries > warmed.reoptRetries,
    };
  }
  return stats;
}
