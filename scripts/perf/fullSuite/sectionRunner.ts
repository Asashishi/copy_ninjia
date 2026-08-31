/** 全量基准分区共用的隔离数据根、播种与子进程按轮编排。 */

import { join } from "node:path";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../../../packages/consts/environment";
import { spawnJsonChild } from "./child";
import {
  PROJECT_ROOT,
  createRuntimeRoot,
  removeMockPath,
} from "./mockRoot";
import { measureDirectoryFootprint } from "./processIo";
import type { SpawnChildOptions } from "./child";
import type { DirectoryFootprint } from "./processIo";
import type { ProcessIoDelta } from "./types";

export interface SectionContext {
  readonly runRoot: string;
  readonly configRoot: string;
  readonly rounds: number;
  readonly onProgress: (message: string) => void;
  readonly recordIo: (io: ProcessIoDelta) => void;
  readonly recordOperations: (operations: number) => void;
  readonly recordFootprint: (footprint: DirectoryFootprint) => void;
  readonly dependencies?: SectionDependencies;
}

/** 父进程的全部外部动作；测试用可控实现验证聚合与失败清理。 */
export interface SectionDependencies {
  readonly spawnJsonChild: <TResult>(options: SpawnChildOptions) => Promise<TResult>;
  readonly createRuntimeRoot: (runRoot: string) => string;
  readonly measureDirectoryFootprint: (runtimeRoot: string) => DirectoryFootprint;
  readonly removeMockPath: (runtimeRoot: string) => void;
}

export interface RoundsOptions {
  readonly label: string;
  readonly seedMode: "cold-start" | "chain" | "none";
  readonly args: readonly string[];
}

const DEFAULT_SECTION_DEPENDENCIES: SectionDependencies = {
  spawnJsonChild,
  createRuntimeRoot,
  measureDirectoryFootprint,
  removeMockPath,
};

export const FULL_SUITE_ENTRY: string = join(
  PROJECT_ROOT,
  "scripts",
  "perf",
  "fullSuite.ts"
);
export const HOT_PATH_ENTRY: string = join(
  PROJECT_ROOT,
  "scripts",
  "perf",
  "hotPaths.ts"
);
export const JOIN_LOG_ENTRY: string = join(
  PROJECT_ROOT,
  "scripts",
  "perf",
  "joinLog.ts"
);

function childEnv(
  runtimeRoot: string,
  configRoot: string
): Readonly<Record<string, string>> {
  return {
    [RUNTIME_DATA_ROOT_ENV]: runtimeRoot,
    [CONFIG_ROOT_ENV]: configRoot,
  };
}

/** 拒绝把不同 Bun/JSC 构建的轮次聚合成一份报告。 */
export function assertSameRuntime(
  version: string,
  revision: string,
  label: string
): void {
  if (version !== Bun.version || revision !== Bun.revision) {
    throw new Error(
      `${label}: child ran Bun ${version} (${revision}), parent runs ` +
      `${Bun.version} (${Bun.revision}).`
    );
  }
}

interface SeedRuntimeRootOptions {
  readonly dependencies: SectionDependencies;
  readonly runtimeRoot: string;
  readonly configRoot: string;
  readonly mode: "cold-start" | "chain";
  readonly label: string;
}

async function seedRuntimeRoot({
  dependencies,
  runtimeRoot,
  configRoot,
  mode,
  label,
}: SeedRuntimeRootOptions): Promise<void> {
  await dependencies.spawnJsonChild<unknown>({
    args: [FULL_SUITE_ENTRY, "--child", "seed", mode],
    env: childEnv(runtimeRoot, configRoot),
    label: `${label} fixture`,
  });
}

/** 每轮使用新数据根，记录删除前足迹，并在成功或失败后统一清理。 */
export async function runRounds<TRound>(
  context: SectionContext,
  { label, seedMode, args }: RoundsOptions
): Promise<readonly TRound[]> {
  const rounds: TRound[] = [];
  const dependencies: SectionDependencies =
    context.dependencies ?? DEFAULT_SECTION_DEPENDENCIES;
  for (let round: number = 0; round < context.rounds; round += 1) {
    const runtimeRoot: string = dependencies.createRuntimeRoot(context.runRoot);
    try {
      if (seedMode !== "none") {
        await seedRuntimeRoot({
          dependencies,
          runtimeRoot,
          configRoot: context.configRoot,
          mode: seedMode,
          label,
        });
      }
      context.onProgress(`${label} ${round + 1}/${context.rounds}`);
      rounds.push(await dependencies.spawnJsonChild<TRound>({
        args,
        env: childEnv(runtimeRoot, context.configRoot),
        label,
      }));
    } finally {
      context.recordFootprint(dependencies.measureDirectoryFootprint(runtimeRoot));
      dependencies.removeMockPath(runtimeRoot);
    }
  }
  return rounds;
}
