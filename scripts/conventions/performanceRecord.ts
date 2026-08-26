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
 * `performance-result.json` 的 `fullSuite.lastRun`；`scripts/perf/fullSuite.ts` 里
 * 那段注释写明「拆成两个 flag 的话，少传一个就会让两者静默错开一个版本」。可它
 * 只是注释——全仓审查时发现两侧**已经**错开：文档写着一次运行的完整读数，而
 * `fullSuite.lastRun` 是 `null`。这里把那条约定变成机器检查。
 *
 * 判定分两层：
 * 1. **三份文档必须同批更新**（`AGENTS.md` 的「三种语言必须同批更新」）。三份区块
 *    里的时间戳必须逐字一致，只更新其中一份当场失败。这一层无条件生效。
 * 2. **JSON 与文档必须是同一次运行**。`fullSuite.lastRun` 非空时，它的
 *    `generatedAt` 必须与文档区块的时间戳一致。
 *
 * `lastRun` 为 `null` 按「从没记录过」放行，与 `AGENTS.md`「声明为可选的字段缺省
 * 按『从没设过』处理」同一口径：`performance-result.json` 是在上一次 `--write-doc`
 * 之后才纳入版本控制的，那个 `null` 是一次性的历史残留，发布流程第 2 步跑完基准
 * 就会补上。**但只要它被写过一次，此后任何一侧单独变动都会在这里失败。**
 */

/** 基准区块里那一个 ISO-8601 时间戳；渲染模板保证每份区块只出现一次。 */
const BLOCK_TIMESTAMP_PATTERN: RegExp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

interface PerformanceResultFile {
  readonly fullSuite?: { readonly lastRun?: { readonly generatedAt?: unknown } | null };
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
  const lastRun: { readonly generatedAt?: unknown } | null | undefined =
    parsed.fullSuite?.lastRun;
  // 从没记录过：留给发布流程第 2 步补齐，不在这里拦住提交。
  if (lastRun === null || lastRun === undefined) return problems;

  const generatedAt: unknown = lastRun.generatedAt;
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
