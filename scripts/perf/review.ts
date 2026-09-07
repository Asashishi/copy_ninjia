/** 专项复核入口：生产热点、启用功能的命令链路与真实 Worker 压力，三轮独立进程。 */
import { join } from "node:path";
import { FULL_SUITE_ROUNDS } from "./fullSuite/constants";
import { createBenchmarkConfigRoot, createRunRoot, removeMockPath } from "./fullSuite/mockRoot";
import { assertSameRuntime, FULL_SUITE_ENTRY, HOT_PATH_ENTRY, runRounds } from "./fullSuite/sectionRunner";
import type { SectionContext } from "./fullSuite/sectionRunner";
import type { RoundsOptions } from "./fullSuite/sectionRunner";
import type { ScenarioName } from "./hotPaths/types";
import type { ChainName } from "./fullSuite/types";

const HOT_PATHS: readonly ScenarioName[] = [
  "sender-stable-username", "flood-window-steady", "identity-permission-read",
  "ai-activity-window", "verification-snapshot", "verification-snapshot-clone",
  "bounded-response-empty", "bounded-response-tiny", "bounded-response-small", "bounded-response-normal", "bounded-response-large",
  "registered-middleware",
];
const CHAINS: readonly ChainName[] = ["ad-detect-command", "ai-reply-command"];
interface ReviewRound {
  readonly bunVersion: string;
  readonly bunRevision: string;
}
interface ReviewResult {
  readonly label: string;
  readonly rounds: readonly ReviewRound[];
}

const mode: string | undefined = Bun.argv[2];
if (Bun.argv.length > 3 || (mode !== undefined && mode !== "--hot-paths" && mode !== "--chains" && mode !== "--worker")) throw new Error("Usage: bun run perf:review [--hot-paths|--chains|--worker]");
const runRoot: string = createRunRoot();
try {
  const context: SectionContext = {
    runRoot, configRoot: await createBenchmarkConfigRoot(runRoot), rounds: FULL_SUITE_ROUNDS,
    onProgress: (message: string): void => { console.error(message); },
    recordIo: (): void => undefined, recordOperations: (): void => undefined, recordFootprint: (): void => undefined,
  };
  const results: ReviewResult[] = [];
  const tasks: RoundsOptions[] = [];
  if (mode === undefined || mode === "--hot-paths") {
    for (const name of HOT_PATHS) {
      tasks.push({ label: name, seedMode: "none", args: [HOT_PATH_ENTRY, name] });
      tasks.push({ label: `${name}:profile`, seedMode: "none", args: [HOT_PATH_ENTRY, name, "--profile"] });
    }
  }
  if (mode === undefined || mode === "--chains") {
    for (const name of CHAINS) tasks.push({ label: name, seedMode: "chain", args: [FULL_SUITE_ENTRY, "--child", "chain", name] });
  }
  if (mode === undefined || mode === "--worker") tasks.push({ label: "disk-worker-pressure", seedMode: "chain", args: [join(import.meta.dir, "review", "diskPressure.ts")] });
  for (const task of tasks) {
    const rounds: readonly ReviewRound[] = await runRounds<ReviewRound>(context, task);
    for (const round of rounds) assertSameRuntime(round.bunVersion, round.bunRevision, task.label);
    results.push({ label: task.label, rounds });
  }
  await Bun.write(Bun.stdout, `${JSON.stringify({ bunVersion: Bun.version, bunRevision: Bun.revision, results })}\n`);
} finally {
  removeMockPath(runRoot);
}
