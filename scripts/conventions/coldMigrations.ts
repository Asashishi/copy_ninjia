import { existsSync } from "node:fs";
import { join } from "node:path";

/** 当前发布支持的一条直接冷迁移边。 */
interface ColdMigrationEdge {
  readonly command: string;
  readonly invocation: string;
  readonly entryPath: string;
  /** 本次直接迁移的状态范围，仅用于让声明可读可核对。 */
  readonly scope: string;
  readonly schemaContract?: Readonly<ColdMigrationSchemaContract>;
}

/** 数据库冷迁移在实现、当前常量和三语操作文档之间必须一致的版本契约。 */
interface ColdMigrationSchemaContract {
  readonly sourceVersion: number;
  readonly resumableVersion: number;
  readonly targetVersion: number;
  readonly currentSchemaPath: string;
  readonly workflowPaths: readonly string[];
  readonly operationsPaths: readonly string[];
}

interface ProjectPackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

interface CollectSchemaContractProblemsOptions {
  readonly edge: Readonly<ColdMigrationEdge>;
  readonly contract: Readonly<ColdMigrationSchemaContract>;
  readonly problems: string[];
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
    scope: "state.global.assets.qaThumbnailUrl",
  },
  {
    command: "migrate:temporary-whitelist",
    invocation: "bun scripts/migrateTemporaryWhitelist.ts",
    entryPath: "scripts/migrateTemporaryWhitelist.ts",
    scope: "database/storage.sqlite schema v5 to v7",
    schemaContract: {
      sourceVersion: 5,
      resumableVersion: 6,
      targetVersion: 7,
      currentSchemaPath: "packages/consts/identityStorage.ts",
      workflowPaths: [
        "docs/cn/05-dev-workflow.md",
        "docs/en/05-dev-workflow.md",
        "docs/ja/05-dev-workflow.md",
      ],
      operationsPaths: [
        "docs/cn/07-operations.md",
        "docs/en/07-operations.md",
        "docs/ja/07-operations.md",
      ],
    },
  },
];

function containsDirectEdge(
  text: string,
  sourceVersion: number,
  targetVersion: number
): boolean {
  return text.includes(`v${sourceVersion} → v${targetVersion}`) ||
    text.includes(`v${sourceVersion} to v${targetVersion}`);
}

async function readContractFile(
  projectRoot: string,
  path: string,
  problems: string[]
): Promise<string | null> {
  const absolutePath: string = join(projectRoot, path);
  if (!existsSync(absolutePath)) {
    problems.push(`cold migration contract file does not exist: ${path}`);
    return null;
  }
  return Bun.file(absolutePath).text();
}

async function collectSchemaContractProblems(
  projectRoot: string,
  {
    edge,
    contract,
    problems,
  }: CollectSchemaContractProblemsOptions
): Promise<void> {
  const currentSchema: string | null = await readContractFile(
    projectRoot,
    contract.currentSchemaPath,
    problems
  );
  if (
    currentSchema !== null &&
    !currentSchema.includes(
      `export const IDENTITY_DATABASE_SCHEMA_VERSION: number = ${contract.targetVersion};`
    )
  ) {
    problems.push(
      `${contract.currentSchemaPath} must declare current identity schema v${contract.targetVersion}`
    );
  }

  const entrySource: string | null = await readContractFile(
    projectRoot,
    edge.entryPath,
    problems
  );
  if (entrySource !== null) {
    const supportedVersions: string =
      `${contract.sourceVersion} | ${contract.resumableVersion} | ${contract.targetVersion}`;
    if (
      !containsDirectEdge(
        entrySource,
        contract.sourceVersion,
        contract.targetVersion
      ) ||
      !entrySource.includes(`): ${supportedVersions} {`) ||
      !entrySource.includes(`if (version === ${contract.sourceVersion}) {`) ||
      !entrySource.includes(`if (version === ${contract.resumableVersion}) {`) ||
      !entrySource.includes(`if (version === ${contract.targetVersion}) {`)
    ) {
      problems.push(
        `${edge.entryPath} must inspect source v${contract.sourceVersion}, resumable intermediate ` +
        `v${contract.resumableVersion}, and target v${contract.targetVersion}`
      );
    }
  }

  for (const path of contract.workflowPaths) {
    const text: string | null = await readContractFile(projectRoot, path, problems);
    if (
      text !== null &&
      !containsDirectEdge(text, contract.sourceVersion, contract.targetVersion)
    ) {
      problems.push(
        `${path} must document the direct v${contract.sourceVersion} to v${contract.targetVersion} migration`
      );
    }
  }
  for (const path of contract.operationsPaths) {
    const text: string | null = await readContractFile(projectRoot, path, problems);
    if (text === null) continue;
    if (
      !containsDirectEdge(text, contract.sourceVersion, contract.targetVersion) ||
      !text.includes(`schema v${contract.targetVersion}`) ||
      !text.includes(`v${contract.resumableVersion}`) ||
      !text.includes("intermediate")
    ) {
      problems.push(
        `${path} must document schema v${contract.targetVersion}, the direct migration edge, and ` +
        `resumable intermediate v${contract.resumableVersion}`
      );
    }
  }
}

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
    if (edge.schemaContract !== undefined) {
      await collectSchemaContractProblems(
        projectRoot,
        { edge, contract: edge.schemaContract, problems }
      );
    }
  }
  return problems;
}
