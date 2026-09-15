/** 手写源码的文件长度硬上限；超过后必须按职责拆分。 */
const MAX_SOURCE_LINES: number = 1_000;

/** 检查 TS、JS 和 shell 源码的物理行数；末尾换行不额外计作空行。 */
export function collectFileLengthProblems(path: string, source: string): readonly string[] {
  if (!/\.(?:[cm]?[jt]sx?|sh)$/.test(path)) return [];
  const lines: number = source.length === 0 ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  return lines > MAX_SOURCE_LINES
    ? [`${path} has ${lines} lines; split source files exceeding ${MAX_SOURCE_LINES} lines`]
    : [];
}
