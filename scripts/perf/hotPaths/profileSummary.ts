/** JSC 稳态栈采样与优化分层摘要；GC 暂停由 gcProfile 独立计量。 */
export interface HotPathSamplingProfileSummary {
  readonly totalSamples: number;
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
 * 解析当前 Bun `bun:jsc.profile` 正式稳态循环中的采样总数与字节码分层字段。
 */
export function summarizeHotPathSamplingProfile(
  profile: HotPathSamplingProfileText
): HotPathSamplingProfileSummary {
  const totalSamples: number = requiredNumber(
    profile.functions,
    /Total samples:\s*(\d+)/,
    "total sample count"
  );
  return {
    totalSamples,
    llintPercent: tierPercent(profile.bytecodes, "LLInt"),
    baselinePercent: tierPercent(profile.bytecodes, "Baseline"),
    dfgPercent: tierPercent(profile.bytecodes, "DFG"),
    ftlPercent: tierPercent(profile.bytecodes, "FTL"),
  };
}
