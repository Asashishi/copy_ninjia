import { existsSync } from "node:fs";
import { join } from "node:path";

/** 当前发布支持的一条直接冷迁移边。 */
interface ColdMigrationEdge {
  readonly command: string;
  readonly invocation: string;
  readonly entryPath: string;
  /** 本次从 state.json 里摘掉的键路径，仅用于让声明可读可核对。 */
  readonly retiredKeyPath: string;
}

interface ProjectPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

/**
 * 当前唯一受支持的那**一组**直接冷迁移边。
 *
 * 下一次发布必须整体替换本声明及对应脚本，把已经随上一个版本发出去的边删干净，
 * 绝不能在旁边保留历史兼容链。
 */
const ACTIVE_COLD_MIGRATION_EDGES: readonly ColdMigrationEdge[] = [
  {
    command: "migrate:qa-thumbnail",
    invocation: "bun scripts/migrateQaThumbnail.ts",
    entryPath: "scripts/migrateQaThumbnail.ts",
    retiredKeyPath: "state.global.assets.qaThumbnailUrl",
  },
];

/** 核对 package 只暴露上面声明的那组冷迁移边，一条不多、一条不少。 */
export async function collectColdMigrationProblems(
  projectRoot: string
): Promise<readonly string[]> {
  const packageJson: ProjectPackageJson = JSON.parse(
    await Bun.file(join(projectRoot, "package.json")).text()
  ) as ProjectPackageJson;
  const scripts: Readonly<Record<string, string>> = packageJson.scripts ?? {};
  const migrationCommands: string[] = Object.keys(scripts).filter(
    (command: string): boolean => command.startsWith("migrate:")
  ).sort();
  const declaredCommands: string[] = ACTIVE_COLD_MIGRATION_EDGES.map(
    (edge: ColdMigrationEdge): string => edge.command
  ).sort();
  const problems: string[] = [];

  if (migrationCommands.join(",") !== declaredCommands.join(",")) {
    problems.push(
      "package.json must expose exactly the declared active cold migration commands " +
      declaredCommands.join(", ")
    );
  }
  for (const edge of ACTIVE_COLD_MIGRATION_EDGES) {
    if (scripts[edge.command] !== edge.invocation) {
      problems.push(`${edge.command} must invoke ${edge.invocation}`);
    }
    if (!existsSync(join(projectRoot, edge.entryPath))) {
      problems.push(`active cold migration entry does not exist: ${edge.entryPath}`);
    }
  }
  return problems;
}
