import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { collectPerformanceRecordProblems } from
  "../../scripts/conventions/performanceRecord";
import {
  README_BLOCK_END,
  README_BLOCK_START,
} from "../../scripts/perf/fullSuite/constants";
import { DOC_PAGE_TARGETS } from "../../scripts/perf/fullSuite/docPage";

const roots: string[] = [];
const GENERATED_AT: string = "2026-08-27T00:00:00Z";

async function fixture(lastRun: unknown, includeFullSuite: boolean = true): Promise<string> {
  const root: string = join(
    tmpdir(),
    `copy-ninjia-performance-record-${crypto.randomUUID()}`
  );
  roots.push(root);
  for (const target of DOC_PAGE_TARGETS) {
    const path: string = join(root, target.path);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(
      path,
      `${README_BLOCK_START}\n${GENERATED_AT}\n${README_BLOCK_END}\n`
    );
  }
  const document: Record<string, unknown> = includeFullSuite
    ? { fullSuite: { lastRun } }
    : {};
  await Bun.write(join(root, "performance-result.json"), JSON.stringify(document));
  return root;
}

/** 只含一个时间戳的合规基准区块。 */
function block(timestamp: string): string {
  return `# Performance\n${README_BLOCK_START}\nGenerated ${timestamp}\n${README_BLOCK_END}\n`;
}

interface RecordFixture {
  /** 按 DOC_PAGE_TARGETS 顺序的三份文档页全文。 */
  readonly pages: readonly string[];
  /** performance-result.json 的原始文本。 */
  readonly result: string;
}

/** 写入任意文档页与原始记录文本，供格式非法的夹具使用。 */
async function recordFixture({ pages, result }: RecordFixture): Promise<string> {
  const root: string = join(
    tmpdir(),
    `copy-ninjia-performance-record-${crypto.randomUUID()}`
  );
  roots.push(root);
  for (const [index, target] of DOC_PAGE_TARGETS.entries()) {
    const path: string = join(root, target.path);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, pages[index] ?? block(GENERATED_AT));
  }
  await Bun.write(join(root, "performance-result.json"), result);
  return root;
}

/** 与三份区块一致的合规记录文本。 */
const MATCHING_RESULT: string = JSON.stringify({ fullSuite: { lastRun: { generatedAt: GENERATED_AT } } });

const BLOCK_PROBLEM_SUFFIX: string =
  "benchmark block must contain exactly one run timestamp; rewrite it with bun run perf:full -- --write-doc";

afterEach((): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("全量性能记录约定", () => {
  test("当前格式的记录与三份文档时间戳一致时通过", async () => {
    const root: string = await fixture({ generatedAt: GENERATED_AT });
    expect(await collectPerformanceRecordProblems(root)).toEqual([]);
  });

  test("拒绝缺失或 null 的 fullSuite.lastRun", async () => {
    const missingRoot: string = await fixture(undefined, false);
    const nullRoot: string = await fixture(null);
    expect(await collectPerformanceRecordProblems(missingRoot)).toContain(
      "performance-result.json: $.fullSuite must be an object with a recorded lastRun"
    );
    expect(await collectPerformanceRecordProblems(nullRoot)).toContain(
      "performance-result.json: $.fullSuite.lastRun must be a recorded benchmark object"
    );
  });

  test("区块缺失、标记颠倒、区块内无时间戳或出现两个不同时间戳时逐页报出", async (): Promise<void> => {
    const firstPath: string = DOC_PAGE_TARGETS[0]!.path;
    for (const page of [
      `# Performance\nGenerated ${GENERATED_AT}\n`,
      `${README_BLOCK_END}\n${GENERATED_AT}\n${README_BLOCK_START}\n`,
      `${README_BLOCK_START}\nno run recorded\n${README_BLOCK_END}\nGenerated ${GENERATED_AT}\n`,
      `${README_BLOCK_START}\n${GENERATED_AT}\n2026-08-28T00:00:00.123Z\n${README_BLOCK_END}\n`,
    ]) {
      const root: string = await recordFixture({ pages: [page], result: MATCHING_RESULT });
      expect(await collectPerformanceRecordProblems(root)).toEqual([`${firstPath}: ${BLOCK_PROBLEM_SUFFIX}`]);
    }
    // 同一个时间戳在区块里重复出现仍算一次运行。
    const repeated: string = await recordFixture({
      pages: [`${README_BLOCK_START}\n${GENERATED_AT}\n${GENERATED_AT}\n${README_BLOCK_END}\n`],
      result: MATCHING_RESULT,
    });
    expect(await collectPerformanceRecordProblems(repeated)).toEqual([]);
  });

  test("三份区块来自不同运行时报出，且不再与 lastRun 单独比对", async (): Promise<void> => {
    const root: string = await recordFixture({
      pages: [block(GENERATED_AT), block("2026-08-28T00:00:00Z")],
      result: MATCHING_RESULT,
    });
    expect(await collectPerformanceRecordProblems(root)).toEqual([
      "docs/{cn,en,ja}/09-performance.md benchmark blocks come from different runs; " +
      "all three must be rewritten by the same bun run perf:full -- --write-doc",
    ]);
  });

  test("lastRun.generatedAt 与三份一致的区块时间戳不同时报出", async (): Promise<void> => {
    const root: string = await recordFixture({
      pages: [],
      result: JSON.stringify({ fullSuite: { lastRun: { generatedAt: "2026-08-28T00:00:00Z" } } }),
    });
    expect(await collectPerformanceRecordProblems(root)).toEqual([
      "performance-result.json $.fullSuite.lastRun and the 09-performance.md benchmark " +
      "blocks describe different runs; both are written by the same " +
      "bun run perf:full -- --write-doc and must never be updated separately",
    ]);
  });

  test("一页区块损坏时其余两页的时间戳仍与 lastRun 比对", async (): Promise<void> => {
    const root: string = await recordFixture({
      pages: ["# Performance\n"],
      result: JSON.stringify({ fullSuite: { lastRun: { generatedAt: "2026-08-28T00:00:00Z" } } }),
    });
    expect(await collectPerformanceRecordProblems(root)).toEqual([
      `${DOC_PAGE_TARGETS[0]!.path}: ${BLOCK_PROBLEM_SUFFIX}`,
      expect.stringContaining("performance-result.json $.fullSuite.lastRun and the 09-performance.md benchmark blocks describe different runs"),
    ]);
  });

  test("generatedAt 缺失、为空串或不是字符串时报出", async (): Promise<void> => {
    for (const lastRun of [{}, { generatedAt: "" }, { generatedAt: 1_756_252_800_000 }, { generatedAt: null }]) {
      const root: string = await recordFixture({ pages: [], result: JSON.stringify({ fullSuite: { lastRun } }) });
      expect(await collectPerformanceRecordProblems(root)).toEqual([
        "performance-result.json: $.fullSuite.lastRun.generatedAt must be a non-empty " +
        "ISO-8601 string once the section has been recorded",
      ]);
    }
  });

  test("fullSuite 或 lastRun 是数组、null 或标量时报出", async (): Promise<void> => {
    for (const fullSuite of [[], null, "recorded"]) {
      const root: string = await recordFixture({ pages: [], result: JSON.stringify({ fullSuite }) });
      expect(await collectPerformanceRecordProblems(root)).toEqual([
        "performance-result.json: $.fullSuite must be an object with a recorded lastRun",
      ]);
    }
    for (const lastRun of [[{ generatedAt: GENERATED_AT }], GENERATED_AT]) {
      const root: string = await recordFixture({ pages: [], result: JSON.stringify({ fullSuite: { lastRun } }) });
      expect(await collectPerformanceRecordProblems(root)).toEqual([
        "performance-result.json: $.fullSuite.lastRun must be a recorded benchmark object",
      ]);
    }
  });

  test("performance-result.json 不是合法 JSON 时门禁直接抛错", async (): Promise<void> => {
    const root: string = await recordFixture({ pages: [], result: "{ fullSuite: " });
    await expect(collectPerformanceRecordProblems(root)).rejects.toThrow();
  });
});
