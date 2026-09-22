import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCoverageMetricProblems,
  declaredCoverageMetrics,
} from "../../scripts/conventions/coverageMetrics";
import type { CoverageMetrics } from "../../scripts/conventions/coverageMetrics";

/** 一次覆盖率运行的五个数字，按文档里的书写形态保存。 */
interface MetricText {
  readonly tests: string;
  readonly files: string;
  readonly expectCalls: string;
  readonly functionPercent: string;
  readonly linePercent: string;
}

const RUN: MetricText = {
  tests: "4850",
  files: "418",
  expectCalls: "160,043",
  functionPercent: "96.75",
  linePercent: "97.95",
};

const DISAGREEMENT: string = "coverage metrics disagree across the project";

function englishSentence(run: MetricText): string {
  return `bun run test:coverage — ${run.tests} tests passed, ${run.files} test files, ` +
    `${run.expectCalls} expect() calls, ${run.functionPercent}% function coverage, ${run.linePercent}% line coverage`;
}

function badges(tests: string, linePercent: string): string {
  return `<a><img src="https://img.shields.io/badge/Tests-${tests}_Passed-2ea44f?style=flat-square" alt="Tests"></a>\n` +
    `<a><img src="https://img.shields.io/badge/Coverage-${linePercent}%25-2ea44f?style=flat-square" alt="Coverage"></a>\n`;
}

/** README 图注挂在 img 的 alt 上；同一行在第二个百分数之后还有 width 数字。 */
function readme(sentence: string, run: MetricText = RUN): string {
  return `# copy-ninjia\n${badges(run.tests, run.linePercent)}` +
    `<img alt="${sentence}" src="public/coverage_light.svg" width="780">\n`;
}

/** 开发流程文档：命令表格行只提命令名，不算指标文案。 */
function devWorkflow(run: MetricText): string {
  return "| `bun run test:coverage` | 测试 + 全源码覆盖率 |\n\n" +
    `\`bun run test:coverage\`：**${run.tests} tests / ${run.files} files / ` +
    `${run.expectCalls.replace(/,/g, "")} 次 \`expect()\`**；全源码**函数覆盖率 ${run.functionPercent}% / ` +
    `行覆盖率 ${run.linePercent}%**。\n`;
}

/** 覆盖率图：aria-label 前面有 viewBox 等数字，数值格逐个画出。 */
function svg(run: MetricText, cells: readonly string[] = [
  run.tests, run.files, run.expectCalls, `${run.functionPercent}%`, `${run.linePercent}%`,
]): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="780" height="120" viewBox="0 0 780 120" ' +
    `role="img" aria-label="${englishSentence(run)}">\n` +
    cells.map((cell: string, index: number): string =>
      `<text class="val" x="${20 + index * 150}" y="80">${cell}</text>`).join("\n") +
    "\n</svg>\n";
}

/** 14 个位置全部描述同一次运行的合规文件集。 */
function consistentFiles(): Record<string, string> {
  return {
    "README.md": readme(
      `bun run test:coverage：${RUN.tests} 项测试全部通过 / ${RUN.files} 个测试文件 / ` +
      `${RUN.expectCalls} 次 expect() 调用 / 函数覆盖率 ${RUN.functionPercent}% / 行覆盖率 ${RUN.linePercent}%`
    ),
    "docs/en/README.md": readme(englishSentence(RUN)),
    // 句尾说明里的数字不属于指标。
    "docs/ja/README.md": readme(
      `bun run test:coverage — ${RUN.tests} 件のテストが全て成功 / テストファイル ${RUN.files} 件 / ` +
      `expect() 呼び出し ${RUN.expectCalls} 回 / 関数カバレッジ ${RUN.functionPercent}% / ` +
      `行カバレッジ ${RUN.linePercent}%（3 言語の README で共通）`
    ),
    "docs/cn/05-dev-workflow.md": devWorkflow(RUN),
    "docs/en/05-dev-workflow.md": devWorkflow(RUN),
    "docs/ja/05-dev-workflow.md": devWorkflow(RUN),
    "public/coverage_light.svg": svg(RUN),
    "public/coverage_dark.svg": svg(RUN),
  };
}

const temporaryRoots: string[] = [];

afterEach((): void => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 在临时仓库根写入合规文件集，再用 overrides 覆盖个别文件。 */
async function fixture(overrides: Readonly<Record<string, string>> = {}): Promise<string> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-coverage-metrics-"));
  temporaryRoots.push(root);
  for (const [path, text] of Object.entries({ ...consistentFiles(), ...overrides })) {
    await Bun.write(join(root, path), text);
  }
  return root;
}

describe("覆盖率指标一致性", () => {
  test("14 个位置描述同一次运行时返回这组数字且不报问题", async (): Promise<void> => {
    const root: string = await fixture();
    const problems: string[] = [];
    const expected: CoverageMetrics = {
      tests: 4850,
      files: 418,
      expectCalls: 160_043,
      functionPercent: 96.75,
      linePercent: 97.95,
    };
    expect(await declaredCoverageMetrics(root, problems)).toEqual(expected);
    expect(problems).toEqual([]);
    expect(await collectCoverageMetricProblems(root)).toEqual([]);
  });

  test("只改一处图注时整体判为不一致并列出双方来源", async (): Promise<void> => {
    const root: string = await fixture({
      "docs/en/05-dev-workflow.md": devWorkflow({ ...RUN, tests: "4851" }),
    });
    const problems: string[] = [];
    expect(await declaredCoverageMetrics(root, problems)).toBeNull();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(DISAGREEMENT);
    expect(problems[0]).toContain(
      "4851 tests / 418 files / 160043 expect() / 96.75% funcs / 97.95% lines <- docs/en/05-dev-workflow.md"
    );
    expect(problems[0]).toContain(
      "4850 tests / 418 files / 160043 expect() / 96.75% funcs / 97.95% lines <- README.md, docs/en/README.md"
    );
  });

  test("覆盖率图画出的数值格与自身 aria-label 不一致时报出", async (): Promise<void> => {
    const root: string = await fixture({
      "public/coverage_light.svg": svg(RUN, ["4850", "418", "160,043", "96.75%", "97.94%"]),
    });
    const problems: readonly string[] = await collectCoverageMetricProblems(root);
    expect(problems).toEqual([expect.stringContaining(DISAGREEMENT)]);
    expect(problems[0]).toContain("97.94% lines <- public/coverage_light.svg (cells)");
  });

  test("README 徽章与同文件图注不一致时报出", async (): Promise<void> => {
    const root: string = await fixture({
      "README.md": readme(englishSentence(RUN), { ...RUN, tests: "4851" }),
      "docs/ja/README.md": readme(englishSentence(RUN), { ...RUN, linePercent: "97.96" }),
    });
    const problems: readonly string[] = await collectCoverageMetricProblems(root);
    expect(problems).toEqual([expect.stringContaining(DISAGREEMENT)]);
    expect(problems[0]).toContain("4851 tests / 418 files / 160043 expect() / 96.75% funcs / 97.95% lines <- README.md (badges)");
    expect(problems[0]).toContain("97.96% lines <- docs/ja/README.md (badges)");
  });

  test("文件里找不到指标文案时报出", async (): Promise<void> => {
    expect(await collectCoverageMetricProblems(await fixture({
      "docs/cn/05-dev-workflow.md": "| `bun run test:coverage` | 测试 + 全源码覆盖率 |\n",
    }))).toEqual(["docs/cn/05-dev-workflow.md: no coverage metric sentence found"]);
    // README 缺图注时徽章无从补齐五元组，只报图注缺失这一条。
    expect(await collectCoverageMetricProblems(await fixture({
      "README.md": `# copy-ninjia\n${badges(RUN.tests, RUN.linePercent)}`,
    }))).toEqual(["README.md: no coverage metric sentence found"]);
  });

  test("指标文案的数字不是恰好五个时报出", async (): Promise<void> => {
    for (const sentence of [
      "`bun run test:coverage`: 4850 tests, 96.75% functions / 97.95% lines\n",
      "`bun run test:coverage`: 4850 tests / 418 files / 12 suites / 160043 expect() / 96.75% / 97.95%\n",
    ]) {
      expect(await collectCoverageMetricProblems(await fixture({ "docs/en/05-dev-workflow.md": sentence }))).toEqual([
        "docs/en/05-dev-workflow.md: coverage sentence must carry exactly five numbers " +
        "(tests, files, expect() calls, function %, line %)",
        "docs/en/05-dev-workflow.md: no coverage metric sentence found",
      ]);
    }
  });

  test("覆盖率图的数值格不是五个时报出", async (): Promise<void> => {
    const root: string = await fixture({
      "public/coverage_dark.svg": svg(RUN, ["4850", "418", "160,043", "96.75%"]),
    });
    expect(await collectCoverageMetricProblems(root)).toEqual([
      "public/coverage_dark.svg: must draw exactly five value cells " +
      "(tests, files, expect() calls, function %, line %), found 4",
    ]);
  });

  test("覆盖率图的数值格无法解析或缺少百分号时报出", async (): Promise<void> => {
    for (const cells of [
      ["4850", "418", "n/a", "96.75%", "97.95%"],
      ["4850", "418", "160,043", "96.75", "97.95"],
    ]) {
      const root: string = await fixture({ "public/coverage_light.svg": svg(RUN, cells) });
      expect(await collectCoverageMetricProblems(root)).toEqual([
        "public/coverage_light.svg: value cells are not five parsable numbers ending in two percentages",
      ]);
    }
  });

  test("README 缺任一徽章时报出", async (): Promise<void> => {
    const root: string = await fixture({
      "docs/en/README.md": "# copy-ninjia\n" +
        `<a><img src="https://img.shields.io/badge/Tests-${RUN.tests}_Passed-2ea44f" alt="Tests"></a>\n` +
        `<img alt="${englishSentence(RUN)}" src="public/coverage_light.svg">\n`,
    });
    expect(await collectCoverageMetricProblems(root)).toEqual([
      "docs/en/README.md: Tests and Coverage badges must both be present",
    ]);
  });

  test("任一指标文件缺失时门禁直接抛错", async (): Promise<void> => {
    const root: string = await fixture();
    rmSync(join(root, "public", "coverage_dark.svg"));
    await expect(collectCoverageMetricProblems(root)).rejects.toThrow();
  });
});
