import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from
  "../../packages/consts/identityStorage";

interface ActiveColdMigrationEdge {
  readonly command: string;
  readonly invocation: string;
  readonly entryPath: string;
  readonly sourceSchemaVersion: number;
  readonly targetSchemaVersion: number;
}

interface ProjectPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

/**
 * 当前唯一受支持的直接冷迁移边。没有新的格式变更时继续保留；下一次格式升级
 * 必须整体替换本声明及脚本，不能在旁边累积第二条历史边。
 */
const ACTIVE_COLD_MIGRATION_EDGE: Readonly<ActiveColdMigrationEdge> = {
  command: "migrate:chat-state",
  invocation: "bun scripts/migrateChatStateToSqlite.ts",
  entryPath: "scripts/migrateChatStateToSqlite.ts",
  sourceSchemaVersion: 3,
  targetSchemaVersion: 4,
};

/** 核对 package 只暴露当前 schema 的上一格式到当前格式这一条冷迁移边。 */
export function collectColdMigrationProblems(projectRoot: string): readonly string[] {
  const packageJson: ProjectPackageJson = JSON.parse(
    readFileSync(join(projectRoot, "package.json"), "utf8")
  ) as ProjectPackageJson;
  const scripts: Readonly<Record<string, string>> = packageJson.scripts ?? {};
  const migrationCommands: string[] = Object.keys(scripts).filter(
    (command: string): boolean => command.startsWith("migrate:")
  );
  const problems: string[] = [];

  if (
    migrationCommands.length !== 1 ||
    migrationCommands[0] !== ACTIVE_COLD_MIGRATION_EDGE.command
  ) {
    problems.push(
      "package.json must expose exactly the declared active cold migration command " +
      ACTIVE_COLD_MIGRATION_EDGE.command
    );
  }
  if (
    scripts[ACTIVE_COLD_MIGRATION_EDGE.command] !==
    ACTIVE_COLD_MIGRATION_EDGE.invocation
  ) {
    problems.push(
      `${ACTIVE_COLD_MIGRATION_EDGE.command} must invoke ` +
      ACTIVE_COLD_MIGRATION_EDGE.invocation
    );
  }
  if (!existsSync(join(projectRoot, ACTIVE_COLD_MIGRATION_EDGE.entryPath))) {
    problems.push(
      `active cold migration entry does not exist: ${ACTIVE_COLD_MIGRATION_EDGE.entryPath}`
    );
  }
  if (
    ACTIVE_COLD_MIGRATION_EDGE.targetSchemaVersion !==
    IDENTITY_DATABASE_SCHEMA_VERSION
  ) {
    problems.push(
      "active cold migration target must equal IDENTITY_DATABASE_SCHEMA_VERSION"
    );
  }
  if (
    ACTIVE_COLD_MIGRATION_EDGE.sourceSchemaVersion !==
    ACTIVE_COLD_MIGRATION_EDGE.targetSchemaVersion - 1
  ) {
    problems.push("active cold migration must cover exactly the previous schema version");
  }
  return problems;
}
