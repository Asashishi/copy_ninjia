import type { CoverageMetrics } from "./conventions/coverageMetrics";

/** `bun test` 摘要行。 */
const RAN_PATTERN: RegExp = /Ran (\d+) tests across (\d+) files/;
/** 断言调用计数。 */
const EXPECT_PATTERN: RegExp = /([\d,]+) expect\(\) calls/;
/** 文本覆盖率报告的合计行。 */
const ALL_FILES_PATTERN: RegExp =
  /^\s*All files\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|/m;

/**
 * 从 Bun 文本测试报告中解析公开指标；任何字段缺失都显式拒绝，避免 reporter
 * 变更后把部分旧值当成新结果写入文档。
 */
export function parseCoverageSummary(output: string): CoverageMetrics {
  const ran: RegExpExecArray | null = RAN_PATTERN.exec(output);
  const expectCalls: RegExpExecArray | null = EXPECT_PATTERN.exec(output);
  const allFiles: RegExpExecArray | null = ALL_FILES_PATTERN.exec(output);
  if (ran === null || expectCalls === null || allFiles === null) {
    throw new Error(
      "Could not read the coverage summary from bun test output; " +
      "the reporter format changed and this parser must be updated."
    );
  }
  return {
    tests: Number(ran[1]!),
    files: Number(ran[2]!),
    expectCalls: Number(expectCalls[1]!.replace(/,/g, "")),
    functionPercent: Number(allFiles[1]!),
    linePercent: Number(allFiles[2]!),
  };
}
