/**
 * 把基准区块写回三语性能基准文档页。
 *
 * 按显式标记整块替换，保留标记之外的标题与导航；标记缺失或顺序非法时拒绝写入。
 */

import { join } from "node:path";
import {
  README_BLOCK_END,
  README_BLOCK_START,
} from "./constants";
import { renderBenchmarkBlock } from "./markdown";
import { PROJECT_ROOT } from "./mockRoot";
import type { Language } from "./markdownCopy";
import type { FullSuiteReport } from "./types";

/** 一份要写入的文档页及其语言。 */
export interface DocPageTarget {
  readonly path: string;
  readonly language: Language;
}

/** 三份性能基准页的固定目标；发布时一起更新，不允许只更新其中一份。 */
export const DOC_PAGE_TARGETS: readonly DocPageTarget[] = [
  { path: join("docs", "cn", "09-performance.md"), language: "zh" },
  { path: join("docs", "en", "09-performance.md"), language: "en" },
  { path: join("docs", "ja", "09-performance.md"), language: "ja" },
];

/**
 * 返回按标记替换后的整页内容；错误信息携带目标路径和所需标记。
 */
export function replaceBlock(source: string, block: string, path: string): string {
  const start: number = source.indexOf(README_BLOCK_START);
  const end: number = source.indexOf(README_BLOCK_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      `${path} has no performance benchmark block. Add the ` +
      `${README_BLOCK_START} / ${README_BLOCK_END} marker pair once, at the ` +
      "place the benchmark results should appear."
    );
  }
  return source.slice(0, start) +
    block +
    source.slice(end + README_BLOCK_END.length);
}

/** 把报告写进三份性能基准页；返回实际改写的路径，供 CLI 回显。 */
export async function writeBenchmarkDocPages(
  report: FullSuiteReport
): Promise<readonly string[]> {
  const written: string[] = [];
  for (const target of DOC_PAGE_TARGETS) {
    const path: string = join(PROJECT_ROOT, target.path);
    const source: string = await Bun.file(path).text();
    const block: string = renderBenchmarkBlock(report, target.language);
    await Bun.write(path, replaceBlock(source, block, target.path));
    written.push(target.path);
  }
  return written;
}
