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
});
