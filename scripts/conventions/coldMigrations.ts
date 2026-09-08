import { existsSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../../packages/consts/identityStorage";
import { TRANSLATE_MIGRATION_SOURCE_RELEASE, TRANSLATE_MIGRATION_TARGET_SCHEMA } from "../migrations/translate/consts";

/** 当前发布支持的一条直接冷迁移边。 */
interface ColdMigrationEdge {
  readonly command: string;
  readonly invocation: string;
  readonly entryPath: string;
  /** 本次直接迁移的状态范围，仅用于让声明可读可核对。 */
  readonly scope: string;
}

interface ProjectPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

/**
 * 当前唯一受支持的那**一组**直接冷迁移边。
 *
 * 10.5.4 的停机备份经 migrate:translate 生成当前格式的独立产物，运维手工替换。
 * 源文件不变，中断后保留现场并向新目录重跑；ready.json 是唯一完成标记。
 * 迁移边、版本契约和对应测试必须整体维护，不追加更早版本的兼容入口。
 */
const ACTIVE_COLD_MIGRATION_EDGES: readonly ColdMigrationEdge[] = [{
  command: "migrate:translate",
  invocation: "bun scripts/migrateTranslate.ts",
  entryPath: "scripts/migrateTranslate.ts",
  scope: "10.5.4 schema v7 and Japanese copy → schema v8 and per-chat translation sessions",
}];

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
  if (TRANSLATE_MIGRATION_SOURCE_RELEASE !== "10.5.4" || TRANSLATE_MIGRATION_TARGET_SCHEMA !== IDENTITY_DATABASE_SCHEMA_VERSION) {
    problems.push("translate cold migration must map release 10.5.4 to the current SQLite schema");
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
