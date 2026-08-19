import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  README_BLOCK_END,
  README_BLOCK_START,
} from "../../scripts/perf/fullSuite/constants";
import { PROJECT_ROOT } from "../../scripts/perf/fullSuite/mockRoot";
import {
  DOC_PAGE_TARGETS,
  replaceBlock,
} from "../../scripts/perf/fullSuite/docPage";
import type { DocPageTarget } from "../../scripts/perf/fullSuite/docPage";

const BLOCK: string = `${README_BLOCK_START}\nrendered\n${README_BLOCK_END}`;

describe("基准区块替换", () => {
  test("整块替换标记之间的内容，保留前后正文", () => {
    const source: string =
      `before\n\n${README_BLOCK_START}\nstale\n${README_BLOCK_END}\n\nafter\n`;
    expect(replaceBlock(source, BLOCK, "09-performance.md"))
      .toBe(`before\n\n${BLOCK}\n\nafter\n`);
  });

  test("空标记对也能首次写入", () => {
    const source: string =
      `before\n\n${README_BLOCK_START}\n${README_BLOCK_END}\n\nafter\n`;
    expect(replaceBlock(source, BLOCK, "09-performance.md")).toContain("rendered");
  });

  test("缺标记、标记顺序颠倒时拒绝写入而不是猜插入位置", () => {
    expect((): string => replaceBlock("no markers here", BLOCK, "README.md"))
      .toThrow("has no performance benchmark block");
    expect((): string => replaceBlock(
      `${README_BLOCK_END}\n${README_BLOCK_START}`,
      BLOCK,
      "09-performance.md"
    )).toThrow("has no performance benchmark block");
  });
});

describe("三份性能基准页的区块", () => {
  test("三种语言各一份，且都已经放好标记对", () => {
    expect(DOC_PAGE_TARGETS.map((target: DocPageTarget): string => target.language))
      .toEqual(["zh", "en", "ja"]);
    expect(DOC_PAGE_TARGETS.map((target: DocPageTarget): string => target.path))
      .toEqual([
        join("docs", "cn", "09-performance.md"),
        join("docs", "en", "09-performance.md"),
        join("docs", "ja", "09-performance.md"),
      ]);
    for (const target of DOC_PAGE_TARGETS) {
      const source: string = readFileSync(join(PROJECT_ROOT, target.path), "utf8");
      const start: number = source.indexOf(README_BLOCK_START);
      const end: number = source.indexOf(README_BLOCK_END);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
    }
  });
});
