import { existsSync } from "node:fs";
import { join } from "node:path";

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
 * 当前为空：从上一个已发布版本到本次发布没有任何持久化格式或 schema 变化，
 * 因此不提供、也不允许存在任何 `migrate:*` 命令。
 *
 * 新增一条边时，除本声明与对应脚本外，还要把该次迁移自身的契约核对一并写在
 * 本文件里（例如 schema 版本号必须与 `packages/consts/` 的当前值一致、入口必须
 * 同时识别源版本、可续跑的 intermediate 版本与目标版本、三语文档必须写明这条
 * 直接边）。那部分核对属于**那一次**迁移，随边一起加、随边一起删。
 *
 * 下一次发布必须整体替换本声明及对应脚本，把已经随上一个版本发出去的边删干净，
 * 绝不能在旁边保留历史兼容链。
 */
const ACTIVE_COLD_MIGRATION_EDGES: readonly ColdMigrationEdge[] = [];

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
