import { join } from "node:path";

/**
 * 三语 README 徽章、三语 README 图注、三份 05-dev-workflow 与两张覆盖率图必须
 * 描述同一次 `bun run test:coverage`。
 *
 * 这组数字散在 8 个文件、14 个位置，由维护者按
 * `docs/cn/05-dev-workflow.md` 的「同步 README 指标」逐处更新；本模块负责拒绝
 * 漏改或互相矛盾的指标。
 *
 * 判定分两层，与 performanceRecord.ts 同一口径：
 * 1. **本文件（`bun run check:conventions`，无条件生效）**：14 个位置必须逐字
 *    携带同一组数字。只改其中一处当场失败。
 * 2. `bun run check:coverage`（scripts/checkCoverageMetrics.ts）：现跑一次
 *    覆盖率，核对这组数字与真实读数一致。它要跑整套测试，因此不进
 *    `bun run check`，由发布流程和显式指令触发。
 *
 * 本层管不了「14 处一起过期」，那一层交给第 2 步；两层合起来才既拦得住手改
 * 漏项，也拦得住整体陈旧。
 */

/** 一次覆盖率运行的五个公开数字。 */
export interface CoverageMetrics {
  readonly tests: number;
  readonly files: number;
  readonly expectCalls: number;
  readonly functionPercent: number;
  readonly linePercent: number;
}

/** 携带完整五元组的位置：`test:coverage` 那句话，语言无关。 */
const METRIC_SENTENCE_FILES: readonly string[] = [
  "README.md",
  "docs/en/README.md",
  "docs/ja/README.md",
  "docs/cn/05-dev-workflow.md",
  "docs/en/05-dev-workflow.md",
  "docs/ja/05-dev-workflow.md",
  "pictures/coverage_light.svg",
  "pictures/coverage_dark.svg",
];

/** 五个数字各占一格画出来的位置：两张覆盖率图的数值单元。 */
const SVG_FILES: readonly string[] = [
  "pictures/coverage_light.svg",
  "pictures/coverage_dark.svg",
];

/** 只携带测试数与行覆盖率的位置：三语 README 顶部的两个 shields 徽章。 */
const BADGE_FILES: readonly string[] = [
  "README.md",
  "docs/en/README.md",
  "docs/ja/README.md",
];

/** 指标文案一律以这个命令名开头；解析从它之后起算。 */
const COMMAND_MARKER: string = "test:coverage";

/** 数字（含千位分隔符与小数），后面可能紧跟一个百分号。 */
const NUMBER_PATTERN: RegExp = /(\d[\d,]*(?:\.\d+)?)(%)?/g;
/** 覆盖率图里画出数值的那五个文本格，按 tests/files/expect/func/line 顺序出现。 */
const SVG_VALUE_PATTERN: RegExp = /class="val"[^>]*>([^<]+)</g;
const TESTS_BADGE_PATTERN: RegExp = /badge\/Tests-(\d+)_Passed/;
const COVERAGE_BADGE_PATTERN: RegExp = /badge\/Coverage-(\d+(?:\.\d+)?)%25/;

function parseNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

/**
 * 从一句指标文案里取出五元组。
 *
 * 两侧各切一刀。**从 `test:coverage` 之后开始收**：SVG 的这句话挂在
 * `<svg>` 标签的 aria-label 上，同一行前面还有 viewBox/width/height 的数字。
 * **读满第二个百分数就停**：句尾的说明文字在日文里带着「3 言語の…」这样的
 * 数字，一路收到行尾会多出一个。两刀之间三种语言的写法落在同一段上。
 */
function metricsFromSentence(line: string): CoverageMetrics | null {
  const start: number = line.indexOf(COMMAND_MARKER);
  if (start < 0) return null;
  const sentence: string = line.slice(start + COMMAND_MARKER.length);
  const values: number[] = [];
  let percentCount: number = 0;
  NUMBER_PATTERN.lastIndex = 0;
  for (
    let match: RegExpExecArray | null = NUMBER_PATTERN.exec(sentence);
    match !== null;
    match = NUMBER_PATTERN.exec(sentence)
  ) {
    values.push(parseNumber(match[1]!));
    if (match[2] !== undefined) percentCount++;
    if (percentCount === 2) break;
  }
  if (percentCount !== 2 || values.length !== 5) return null;
  return {
    tests: values[0]!,
    files: values[1]!,
    expectCalls: values[2]!,
    functionPercent: values[3]!,
    linePercent: values[4]!,
  };
}

/** 一行是否是指标文案：提到 test:coverage，且带至少两个百分数。 */
function isMetricSentence(line: string): boolean {
  if (!line.includes(COMMAND_MARKER)) return false;
  return (line.match(/\d(?:[\d,]*(?:\.\d+)?)%/g)?.length ?? 0) >= 2;
}

/** 收集一个文件里全部指标文案的解析结果。 */
function sentenceMetrics(
  path: string,
  source: string,
  problems: string[]
): CoverageMetrics[] {
  const found: CoverageMetrics[] = [];
  for (const line of source.split("\n")) {
    if (!isMetricSentence(line)) continue;
    const metrics: CoverageMetrics | null = metricsFromSentence(line);
    if (metrics === null) {
      problems.push(
        `${path}: coverage sentence must carry exactly five numbers ` +
        "(tests, files, expect() calls, function %, line %)"
      );
      continue;
    }
    found.push(metrics);
  }
  if (found.length === 0) {
    problems.push(`${path}: no coverage metric sentence found`);
  }
  return found;
}

function formatMetrics(metrics: CoverageMetrics): string {
  return `${metrics.tests} tests / ${metrics.files} files / ` +
    `${metrics.expectCalls} expect() / ${metrics.functionPercent}% funcs / ` +
    `${metrics.linePercent}% lines`;
}

/**
 * 读出仓库当前声明的覆盖率指标；14 个位置不一致时返回 null 并记下问题。
 * `bun run check:coverage` 复用它，避免两处各写一份解析。
 */
export async function declaredCoverageMetrics(
  projectRoot: string,
  problems: string[]
): Promise<CoverageMetrics | null> {
  const seen: Map<string, string[]> = new Map();
  const record = (metrics: CoverageMetrics, where: string): void => {
    const key: string = formatMetrics(metrics);
    const places: string[] | undefined = seen.get(key);
    if (places === undefined) seen.set(key, [where]);
    else places.push(where);
  };

  for (const path of METRIC_SENTENCE_FILES) {
    const source: string = await Bun.file(join(projectRoot, path)).text();
    for (const metrics of sentenceMetrics(path, source, problems)) {
      record(metrics, path);
    }
  }

  for (const path of SVG_FILES) {
    // 图里的五个数值格与同一张图的 aria-label/title 是两套独立文本，必须逐格
    // 核对：只比对那句 label 的话，画出来的数字改错一格照样通得过。
    const source: string = await Bun.file(join(projectRoot, path)).text();
    const cells: string[] = [];
    SVG_VALUE_PATTERN.lastIndex = 0;
    for (
      let match: RegExpExecArray | null = SVG_VALUE_PATTERN.exec(source);
      match !== null;
      match = SVG_VALUE_PATTERN.exec(source)
    ) cells.push(match[1]!.trim());
    if (cells.length !== 5) {
      problems.push(
        `${path}: must draw exactly five value cells ` +
        `(tests, files, expect() calls, function %, line %), found ${cells.length}`
      );
      continue;
    }
    const drawn: CoverageMetrics | null = metricsFromSentence(
      `${COMMAND_MARKER} ${cells.join(" ")}`
    );
    if (drawn === null) {
      problems.push(`${path}: value cells are not five parsable numbers ending in two percentages`);
      continue;
    }
    record(drawn, `${path} (cells)`);
  }

  for (const path of BADGE_FILES) {
    const source: string = await Bun.file(join(projectRoot, path)).text();
    const tests: RegExpExecArray | null = TESTS_BADGE_PATTERN.exec(source);
    const line: RegExpExecArray | null = COVERAGE_BADGE_PATTERN.exec(source);
    if (tests === null || line === null) {
      problems.push(`${path}: Tests and Coverage badges must both be present`);
      continue;
    }
    // 徽章只带两个数字，补齐成五元组才能与上面同一张表比对；补的两位取自
    // 本文件的指标文案，因此徽章与图注不一致时照样能被这张表抓到。
    const sentence: CoverageMetrics | undefined = sentenceMetrics(path, source, [])[0];
    if (sentence === undefined) continue;
    record({
      tests: Number(tests[1]!),
      files: sentence.files,
      expectCalls: sentence.expectCalls,
      functionPercent: sentence.functionPercent,
      linePercent: Number(line[1]!),
    }, `${path} (badges)`);
  }

  if (seen.size <= 1) {
    const only: string | undefined = [...seen.keys()][0];
    return only === undefined ? null : metricsFromSentence(`${COMMAND_MARKER} ${only}`);
  }
  const detail: string = [...seen]
    .map(([metrics, places]: [string, string[]]): string => `  ${metrics} <- ${places.join(", ")}`)
    .join("\n");
  problems.push(
    "coverage metrics disagree across the project; every location must be rewritten " +
    `from the same bun run test:coverage output:\n${detail}`
  );
  return null;
}

/** 核对全部覆盖率指标位置描述同一次运行。 */
export async function collectCoverageMetricProblems(
  projectRoot: string
): Promise<readonly string[]> {
  const problems: string[] = [];
  await declaredCoverageMetrics(projectRoot, problems);
  return problems;
}
