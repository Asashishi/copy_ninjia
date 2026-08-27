import { join } from "node:path";
import {
  README_BLOCK_END,
  README_BLOCK_START,
} from "../perf/fullSuite/constants";
import { DOC_PAGE_TARGETS } from "../perf/fullSuite/docPage";

/**
 * 全量基准的两种呈现必须描述同一次运行。
 *
 * `bun run perf:full -- --write-doc` 同时写三份 `09-performance.md` 的基准区块与
 * `performance-result.json` 的 `fullSuite.lastRun`。三份文档时间戳必须一致，
 * `lastRun.generatedAt` 必须存在且与该时间戳相同；缺失、null 或单侧更新均失败。
 */

/** 基准区块里那一个 ISO-8601 时间戳；渲染模板保证每份区块只出现一次。 */
const BLOCK_TIMESTAMP_PATTERN: RegExp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

interface PerformanceResultFile {
  readonly fullSuite?: unknown;
}

/** 取一份文档页基准区块里的时间戳；区块缺失或没有时间戳时返回 null。 */
function blockTimestamp(source: string): string | null {
  const start: number = source.indexOf(README_BLOCK_START);
  const end: number = source.indexOf(README_BLOCK_END);
  if (start < 0 || end < 0 || end < start) return null;
  const block: string = source.slice(start, end);
  const matches: RegExpMatchArray | null = block.match(BLOCK_TIMESTAMP_PATTERN);
  if (matches === null || matches.length === 0) return null;
  // 同一区块里出现两个不同时间戳，说明整块替换没有整块生效。
  const unique: ReadonlySet<string> = new Set(matches);
  return unique.size === 1 ? matches[0] ?? null : null;
}

/** 核对全量基准的文档区块与 `performance-result.json` 描述同一次运行。 */
export async function collectPerformanceRecordProblems(
  projectRoot: string
): Promise<readonly string[]> {
  const problems: string[] = [];
  const timestamps: Map<string, string | null> = new Map();
  for (const target of DOC_PAGE_TARGETS) {
    const source: string = await Bun.file(join(projectRoot, target.path)).text();
    timestamps.set(target.path, blockTimestamp(source));
  }

  const present: string[] = [];
  for (const [path, timestamp] of timestamps) {
    if (timestamp === null) {
      problems.push(
        `${path}: benchmark block must contain exactly one run timestamp; ` +
        "rewrite it with bun run perf:full -- --write-doc"
      );
      continue;
    }
    present.push(timestamp);
  }
  const distinct: ReadonlySet<string> = new Set(present);
  if (distinct.size > 1) {
    problems.push(
      "docs/{cn,en,ja}/09-performance.md benchmark blocks come from different runs; " +
      "all three must be rewritten by the same bun run perf:full -- --write-doc"
    );
  }

  const raw: string = await Bun.file(
    join(projectRoot, "performance-result.json")
  ).text();
  const parsed: PerformanceResultFile = JSON.parse(raw) as PerformanceResultFile;
  const fullSuite: unknown = parsed.fullSuite;
  if (
    typeof fullSuite !== "object" ||
    fullSuite === null ||
    Array.isArray(fullSuite)
  ) {
    problems.push(
      "performance-result.json: $.fullSuite must be an object with a recorded lastRun"
    );
    return problems;
  }
  const lastRun: unknown = (fullSuite as Record<string, unknown>).lastRun;
  if (
    typeof lastRun !== "object" ||
    lastRun === null ||
    Array.isArray(lastRun)
  ) {
    problems.push(
      "performance-result.json: $.fullSuite.lastRun must be a recorded benchmark object"
    );
    return problems;
  }

  const generatedAt: unknown = (lastRun as Record<string, unknown>).generatedAt;
  if (typeof generatedAt !== "string" || generatedAt.length === 0) {
    problems.push(
      "performance-result.json: $.fullSuite.lastRun.generatedAt must be a non-empty " +
      "ISO-8601 string once the section has been recorded"
    );
    return problems;
  }
  if (distinct.size === 1 && !distinct.has(generatedAt)) {
    problems.push(
      "performance-result.json $.fullSuite.lastRun and the 09-performance.md benchmark " +
      "blocks describe different runs; both are written by the same " +
      "bun run perf:full -- --write-doc and must never be updated separately"
    );
  }
  return problems;
}
