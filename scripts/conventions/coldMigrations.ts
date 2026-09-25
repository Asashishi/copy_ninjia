import { existsSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../../packages/consts/identityStorage";

import { ACTIVE_COLD_MIGRATION_EDGES } from "../migrations/active";
import type { ColdMigrationEdge } from "../migrations/active";

interface ProjectPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

/** 核对 package 只暴露 migrations/active.ts 声明的冷迁移边，一条不多、一条不少。 */
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
  if (IDENTITY_DATABASE_SCHEMA_VERSION !== 11) {
    problems.push("translation session cold migration must operate on the current SQLite schema v11");
  }

  if (migrationCommands.join(",") !== declaredCommands.join(",")) {
    problems.push(
      "package.json must expose exactly the declared active cold migration commands " +
      (declaredCommands.length === 0 ? "(none)" : declaredCommands.join(", "))
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
