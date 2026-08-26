import { describe, expect, test } from "bun:test";
import {
  parseOptions,
  writeSuiteDocuments,
} from "../../scripts/perf/fullSuite";
import type {
  SuiteDocumentWriters,
  SuiteOptions,
} from "../../scripts/perf/fullSuite";
import type { FullSuiteReport } from "../../scripts/perf/fullSuite/types";
import type { WritePerformanceResultEntryParams } from "../../scripts/perf/performanceResult";

describe("全量基准 CLI 选项", () => {
  test("--write-doc 单个开关同步页面与结构化报告", async () => {
    const options: SuiteOptions = parseOptions(["--", "--write-doc"]);
    const report: FullSuiteReport = {} as FullSuiteReport;
    const pageReports: FullSuiteReport[] = [];
    const resultWrites: WritePerformanceResultEntryParams[] = [];
    const writers: SuiteDocumentWriters = {
      writeBenchmarkDocPages: async (
        value: FullSuiteReport
      ): Promise<readonly string[]> => {
        pageReports.push(value);
        return ["docs/cn/09-performance.md", "docs/en/09-performance.md"];
      },
      writePerformanceResultEntry: async (
        params: WritePerformanceResultEntryParams
      ): Promise<void> => {
        resultWrites.push(params);
      },
    };

    const paths: readonly string[] = options.writeDoc
      ? await writeSuiteDocuments(report, writers)
      : [];

    expect(options).toEqual({ rounds: 3, markdown: false, writeDoc: true });
    expect(paths).toHaveLength(2);
    expect(pageReports).toEqual([report]);
    expect(resultWrites).toEqual([expect.objectContaining({
      section: "fullSuite",
      entry: "lastRun",
      value: report,
    })]);
  });

  test("非法轮数与未知选项 fail-closed", () => {
    expect((): SuiteOptions => parseOptions(["--rounds", "0"]))
      .toThrow("positive integer");
    expect((): SuiteOptions => parseOptions(["--write-result"]))
      .toThrow("Unknown option");
  });
});
