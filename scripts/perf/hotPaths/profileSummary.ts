/** JSC 稳态采样中与 GC 和优化分层有关的机器可判摘要。 */
export interface HotPathSamplingProfileSummary {
  readonly totalSamples: number;
  readonly gcSamples: number;
  readonly gcPercent: number;
  readonly llintPercent: number;
  readonly baselinePercent: number;
  readonly dfgPercent: number;
  readonly ftlPercent: number;
}

export interface HotPathSamplingProfileText {
  readonly functions: string;
  readonly bytecodes: string;
}

function requiredNumber(text: string, pattern: RegExp, label: string): number {
  const value: string | undefined = pattern.exec(text)?.[1];
  if (value === undefined) {
    throw new Error(`JSC sampling profile omitted ${label}.`);
  }
  const parsed: number = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`JSC sampling profile returned an invalid ${label}.`);
  }
  return parsed;
}

function tierPercent(bytecodes: string, tier: string): number {
  return requiredNumber(
    bytecodes,
    new RegExp(`^${tier}:\\s+\\d+\\s+\\(([\\d.]+)%\\)`, "m"),
    `${tier} percentage`
  );
}

/**
 * 解析当前 Bun `bun:jsc.profile` 输出的采样总数、GC 栈与字节码分层字段。
 * 采样只包住正式稳态循环，
 * 因此这里的 gc 不包含脚本加载、预热或 retained-heap 两侧的强制 GC。
 */
export function summarizeHotPathSamplingProfile(
  profile: HotPathSamplingProfileText
): HotPathSamplingProfileSummary {
  const totalSamples: number = requiredNumber(
    profile.functions,
    /Total samples:\s*(\d+)/,
    "total sample count"
  );
  const gcMatch: RegExpExecArray | null = /^\s*(\d+)\s+'gc#/m.exec(
    profile.functions
  );
  const gcSamples: number = gcMatch === null ? 0 : Number(gcMatch[1]);
  return {
    totalSamples,
    gcSamples,
    gcPercent: totalSamples === 0 ? 0 : (gcSamples / totalSamples) * 100,
    llintPercent: tierPercent(profile.bytecodes, "LLInt"),
    baselinePercent: tierPercent(profile.bytecodes, "Baseline"),
    dfgPercent: tierPercent(profile.bytecodes, "DFG"),
    ftlPercent: tierPercent(profile.bytecodes, "FTL"),
  };
}
