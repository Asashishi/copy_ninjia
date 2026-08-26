import { describe, expect, test } from "bun:test";
import { parseCoverageSummary } from "../../scripts/coverageSummary";

describe("coverage summary parser", () => {
  test("同时解析测试摘要、千位断言数与覆盖率合计", () => {
    const output: string = `
      96,187 expect() calls
      Ran 2805 tests across 286 files. [12.34s]
      All files | 95.77 | 97.20 | 100.00
    `;

    expect(parseCoverageSummary(output)).toEqual({
      tests: 2_805,
      files: 286,
      expectCalls: 96_187,
      functionPercent: 95.77,
      linePercent: 97.2,
    });
  });

  test("stdout 与 stderr 拼接顺序不影响解析", () => {
    const output: string =
      "All files | 90 | 91 |\n" +
      "Ran 12 tests across 3 files.\n" +
      "44 expect() calls\n";

    expect(parseCoverageSummary(output)).toEqual({
      tests: 12,
      files: 3,
      expectCalls: 44,
      functionPercent: 90,
      linePercent: 91,
    });
  });

  test("任一摘要字段缺失时显式拒绝 reporter 漂移", () => {
    expect((): void => { parseCoverageSummary("Ran 12 tests across 3 files."); })
      .toThrow("reporter format changed");
  });
});
