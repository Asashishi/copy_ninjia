import { join } from "node:path";
import {
  declaredCoverageMetrics,
  type CoverageMetrics,
} from "./conventions/coverageMetrics";
import { parseCoverageSummary } from "./coverageSummary";

/**
 * 现跑一次 `bun test --isolate --coverage`，核对仓库声明的覆盖率指标与真实读数一致。
 *
 * 与 `bun run check:conventions` 里那层的分工写在 conventions/coverageMetrics.ts
 * 的头注：那层只判 14 个位置彼此一致（无条件生效、零成本），管不了「14 处一起
 * 过期」；这一层判它们与真实读数一致，代价是整跑一遍测试，因此不进
 * `bun run check`，由 `bun run release:check` 与显式指令触发。
 *
 * 失败时只报差异，不改文件：要改哪些位置见 docs/cn/05-dev-workflow.md 的
 * 「同步 README 指标」。
 */

const PROJECT_ROOT: string = join(import.meta.dir, "..");

function measuredCoverageMetrics(): CoverageMetrics {
  const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
    cmd: ["bun", "test", "--isolate", "--coverage", "--coverage-reporter=text"],
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  // bun test 把摘要与覆盖率表都写到 stderr；两股都读，不依赖它写在哪一股。
  const output: string = `${result.stdout.toString()}\n${result.stderr.toString()}`;
  if (result.exitCode !== 0) {
    throw new Error(
      "bun test --coverage failed; fix the suite before syncing the metrics."
    );
  }
  return parseCoverageSummary(output);
}

function describe(metrics: CoverageMetrics): string {
  return `${metrics.tests} tests / ${metrics.files} files / ` +
    `${metrics.expectCalls} expect() calls / ` +
    `${metrics.functionPercent}% function coverage / ` +
    `${metrics.linePercent}% line coverage`;
}

const problems: string[] = [];
const declared: CoverageMetrics | null = await declaredCoverageMetrics(
  PROJECT_ROOT,
  problems
);
if (declared === null) {
  console.error("Coverage metric check failed before measuring:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

const measured: CoverageMetrics = measuredCoverageMetrics();
if (describe(declared) === describe(measured)) {
  console.log(`Coverage metrics are current: ${describe(measured)}`);
} else {
  console.error("Coverage metrics are stale:");
  console.error(`- declared: ${describe(declared)}`);
  console.error(`- measured: ${describe(measured)}`);
  console.error(
    "Rewrite every location listed under 「同步 README 指标」 in docs/cn/05-dev-workflow.md."
  );
  process.exit(1);
}
