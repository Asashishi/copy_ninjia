/** 文本清洗专项的父进程编排：每个场景按轮独立进程运行，逐轮合并 GC 暂停并汇总耗时。 */
import { join } from "node:path";
import { JSC_GC_LOG_ENV } from "../../../packages/consts/environment";
import { assertSameRuntime, runRounds } from "../fullSuite/sectionRunner";
import type { SectionContext } from "../fullSuite/sectionRunner";
import { summarizeGcPauseProfile } from "../hotPaths/gcProfile";
import type { GcPauseProfile } from "../hotPaths/gcProfile";
import { mean, standardDeviation } from "../statistics";
import { TEXT_REVIEW_SCENARIOS } from "./textFixture";
import type { TextReviewScenario } from "./textFixture";
import type { TextReviewChildResult } from "./textChild";

const TEXT_REVIEW_CHILD_ENTRY: string = join(import.meta.dir, "textChild.ts");

/** 一轮读数：子进程结果加上父进程从其 stderr 解析出的 GC 暂停。 */
export interface TextReviewRound extends TextReviewChildResult {
  readonly gcProfile: GcPauseProfile;
}

/** 一个场景的逐轮读数与按轮中位数计算的汇总。 */
export interface TextReviewResult {
  readonly label: string;
  readonly rounds: readonly TextReviewRound[];
  readonly summary: {
    readonly meanNsPerOp: number;
    readonly minNsPerOp: number;
    readonly maxNsPerOp: number;
    readonly cvPercent: number;
    readonly allJitStable: boolean;
  };
}

/** 依次运行全部文本专项场景；任一轮失败即整体失败。 */
export async function runTextReview(context: SectionContext): Promise<readonly TextReviewResult[]> {
  const results: TextReviewResult[] = [];
  for (const scenario of TEXT_REVIEW_SCENARIOS) {
    results.push(await runTextScenario(context, scenario));
  }
  return results;
}

async function runTextScenario(
  context: SectionContext,
  scenario: TextReviewScenario
): Promise<TextReviewResult> {
  const label: string = `text:${scenario.name}`;
  const gcProfiles: GcPauseProfile[] = [];
  const childRounds: readonly TextReviewChildResult[] = await runRounds<TextReviewChildResult>(context, {
    label,
    seedMode: "none",
    args: [TEXT_REVIEW_CHILD_ENTRY, scenario.name],
    env: { [JSC_GC_LOG_ENV]: "1" },
    onStderr: (stderr: string): void => { gcProfiles.push(summarizeGcPauseProfile(stderr)); },
  });
  const rounds: TextReviewRound[] = [];
  const medians: number[] = [];
  for (const [index, round] of childRounds.entries()) {
    assertSameRuntime(round.bunVersion, round.bunRevision, label);
    const gcProfile: GcPauseProfile | undefined = gcProfiles[index];
    if (gcProfile === undefined) throw new Error(`${label}: round ${index + 1} has no GC profile.`);
    rounds.push({ ...round, gcProfile });
    medians.push(round.medianNsPerOp);
  }
  const average: number = mean(medians);
  return {
    label,
    rounds,
    summary: {
      meanNsPerOp: average,
      minNsPerOp: Math.min(...medians),
      maxNsPerOp: Math.max(...medians),
      cvPercent: standardDeviation(medians, average) / average * 100,
      allJitStable: rounds.every((round: TextReviewRound): boolean => round.jitStableDuringSampling),
    },
  };
}
