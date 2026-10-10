/**
 * 源码与二进制共用的冷迁移端到端验证：以上一次迁移产出格式的停机备份执行当前全部冷迁移边；全部路径归
 * 调用方的独立临时根所有。
 */
import { expect } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import { ASSET_ONLY_PATH_GROUP, ASSET_ONLY_URL_GROUP, ASSET_PATH_OR_URL_GROUP } from "../../packages/consts/ui/assets";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../../packages/consts/identityStorage";
import { ACTIVE_COLD_MIGRATION_EDGES } from "../migrations/active";
import { CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION } from "../migrations/chatPersonaRemoval/database";
import { copyFixtureTree } from "./copyTree";
import { googleAuthFixture } from "./googleAuth";
import { createMigrationDatabase, assertMigratedDatabase } from "./migrationDatabase";
import type { MigrationDatabaseFixture } from "./migrationDatabase";
import { readMigrationFileSnapshot } from "./migrationFiles";
import type { MigrationFileSnapshot } from "./migrationFiles";
import { runCapturedCommand } from "./subprocess";
import type { CapturedCommandResult } from "./subprocess";
import type { ChatPersonaRemovalMigrationResult } from "../migrateChatPersonaRemoval";

export interface MigrationDeploymentOptions {
  readonly packageRoot: string;
  readonly root: string;
  readonly binary?: boolean;
}

export interface MigratedDeployment {
  readonly config: string;
  readonly data: string;
  readonly database: MigrationDatabaseFixture;
  readonly sources: readonly MigrationFileSnapshot[];
}

/** 冷迁移输入格式的 bot.json（没有 time_zone）；身份与安装器夹具的 API 桩一致。 */
const BOT_IDENTITY: Readonly<Record<string, unknown>> = {
  bot_token: "123456789:migration_test_token",
  super_admin_user_id: 123456789,
  atmosphere: "mesugaki",
};

/** 含凭据、须保持 0600 的部署文件在当前布局下的相对路径。 */
const SECRET_CONFIG_FILES: readonly string[] = [
  join(STATIC_CONFIG_DIR_NAME, "bot.json"),
  join(DYNAMIC_CONFIG_DIR_NAME, "agent.json"),
  join(STATIC_CONFIG_DIR_NAME, "g-auth.json"),
];

/** 冷迁移不涉及、部署时原样沿用的配置；安装与启动后必须逐字节不变。 */
export const PRESERVED_MIGRATION_CONFIG_FILES: readonly string[] = [
  join(STATIC_CONFIG_DIR_NAME, "g-auth.json"),
  ...["agent.json", "ad_samples.json", "mood.json", "stickers.json", "assets.json"].map(
    (name: string): string => join(DYNAMIC_CONFIG_DIR_NAME, name)
  ),
];

/** 每条冷迁移边在源备份上的参数；产物目录参数由调用处补上。 */
function migrationArguments(command: string, data: string): readonly string[] {
  if (command === "migrate:chat-persona-removal") return ["--source-root", data];
  throw new Error(`No 16.3.2 fixture arguments for cold migration ${command}.`);
}

/**
 * 建立上一次迁移产出格式的完整 mock 停机备份（当前配置布局、当前全局状态、内容摘要命名的图库与源
 * schema 库，复读与翻译目标及群名含空字符串），执行实际 CLI，核对拒绝覆盖与源哈希，再按清单组装部署目录：
 * 只替换数据库，其余文件原样沿用。
 */
export async function prepareMigratedDeployment({
  packageRoot, root, binary = false,
}: MigrationDeploymentOptions): Promise<MigratedDeployment> {
  await mkdir(root);
  const config: string = join(root, "source config");
  const data: string = join(root, "source data");
  const deployment: string = join(root, "deployment");
  const deployedConfig: string = join(deployment, "config");
  const deployedData: string = join(deployment, "data");
  const images: string = join(deployment, "h_image");
  for (const directory of [
    join(config, STATIC_CONFIG_DIR_NAME), join(config, DYNAMIC_CONFIG_DIR_NAME), data, deployedConfig, deployedData, images,
  ]) await mkdir(directory, { recursive: true });
  await Bun.write(join(config, STATIC_CONFIG_DIR_NAME, "bot.json"), JSON.stringify(BOT_IDENTITY));
  await Bun.write(join(config, STATIC_CONFIG_DIR_NAME, "g-auth.json"), await googleAuthFixture());
  await Bun.write(join(config, DYNAMIC_CONFIG_DIR_NAME, "agent.json"), JSON.stringify({ agent: {
    text: { provider: "openai", api_key: "migration-test-key", model: "test" },
    summary: { provider: "openai", api_key: "migration-test-key", model: "test" },
    media: { provider: "openai", api_key: "migration-test-key", model: "test" },
  } }));
  for (const path of SECRET_CONFIG_FILES) chmodSync(join(config, path), 0o600);
  await Bun.write(join(config, DYNAMIC_CONFIG_DIR_NAME, "ad_samples.json"), JSON.stringify(["迁移前的广告示例"]));
  await Bun.write(join(config, DYNAMIC_CONFIG_DIR_NAME, "stickers.json"), JSON.stringify({ packs: [] }));
  await Bun.write(join(config, DYNAMIC_CONFIG_DIR_NAME, "mood.json"), JSON.stringify({
    moods: [{ name: "迁移心情", weight: 100, instruction: "迁移前的心情指令" }],
  }));
  await Bun.write(join(config, DYNAMIC_CONFIG_DIR_NAME, "assets.json"), JSON.stringify({
    [ASSET_ONLY_PATH_GROUP]: { random_h_image_dir: images },
    [ASSET_PATH_OR_URL_GROUP]: {},
    [ASSET_ONLY_URL_GROUP]: { fortune_thumbnail_url: "https://example.com/fortune.png" },
  }));
  const image: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await Bun.write(join(images, `${new Bun.CryptoHasher("sha256").update(image).digest("hex")}.png`), image);
  const copy: Readonly<Record<string, unknown>> = {
    copiedUser: { id: 42, first_name: "", last_name: "" }, copyChatId: -1001, lastCopyTime: 12,
  };
  await mkdir(join(data, "memory/global"), { recursive: true });
  await Bun.write(join(data, "memory/global/state.json"), JSON.stringify({
    copy, ttsUsage: { windowStartedAt: 1_000, agentCount: 7, reserveCount: 3 },
  }, null, 2));
  await mkdir(join(data, "memory/wed"), { recursive: true });
  await Bun.write(join(data, "memory/wed/-1001.json"), "[42,43]");
  await mkdir(join(data, "logs"));
  await Bun.write(join(data, "logs/mock-history.json"), "[]");
  const database: MigrationDatabaseFixture = await createMigrationDatabase({ packageRoot, root, source: data });
  const sources: MigrationFileSnapshot[] = [];
  for (const directory of [config, data]) {
    for await (const name of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true })) {
      sources.push((await readMigrationFileSnapshot(join(directory, name)))!);
    }
  }
  const guard: string = join(root, "no-outbound.js");
  await Bun.write(guard, [
    'globalThis.fetch = () => { throw new Error("MIGRATION_NETWORK_BLOCKED"); };',
    'globalThis.Worker = class { constructor() { throw new Error("MIGRATION_WORKER_BLOCKED"); } };',
  ].join("\n"));
  async function run(args: readonly string[], success: boolean): Promise<string> {
    const result: CapturedCommandResult = await runCapturedCommand({
      cmd: [binary ? join(packageRoot, "copy-ninjia") : Bun.argv[0]!, "--preload", guard, ...args],
      cwd: root,
      env: { PATH: "/usr/bin:/bin", HOME: root, BUN_BE_BUN: "1", COPY_NINJIA_DATA_ROOT: data, COPY_NINJIA_CONFIG_ROOT: join(root, "absent-config") },
      timeout: 30_000, killSignal: "SIGKILL",
    });
    const output: string = result.stdout + result.stderr;
    expect(result.exitCode === 0, output).toBe(success);
    expect(output).not.toMatch(/MIGRATION_(NETWORK|WORKER)_BLOCKED/);
    return output;
  }
  const outputs: Map<string, string> = new Map();
  for (const edge of ACTIVE_COLD_MIGRATION_EDGES) {
    const script: string = join(packageRoot, binary ? edge.bundledPath : edge.entryPath);
    expect(await run([script, "--help"], true)).toContain(edge.command);
    await run([script, "--unknown"], false);
    const output: string = join(root, edge.command.replaceAll(":", "-"));
    const args: readonly string[] = [script, ...migrationArguments(edge.command, data), "--output-root", output];
    await run(args, true);
    const ready: MigrationFileSnapshot | null = await readMigrationFileSnapshot(join(output, "ready.json"));
    if (ready === null) throw new Error(`Missing migration output: ${edge.command}`);
    expect(await Bun.file(join(output, "incomplete.json")).exists()).toBeFalse();
    await run(args, false);
    expect(await readMigrationFileSnapshot(ready.path)).toEqual(ready);
    outputs.set(edge.command, output);
  }
  const databaseOutput: string = outputs.get("migrate:chat-persona-removal")!;
  const databaseResult: ChatPersonaRemovalMigrationResult = await Bun.file(join(databaseOutput, "ready.json")).json() as ChatPersonaRemovalMigrationResult;
  expect(databaseResult).toMatchObject({
    sourceSchema: CHAT_PERSONA_REMOVAL_SOURCE_SCHEMA_VERSION, targetSchema: IDENTITY_DATABASE_SCHEMA_VERSION,
    removedPersonas: 2, removedEmptyChats: 1, removedPermissions: 2,
  });
  expect(databaseResult.outputFiles.map((file: { readonly path: string }): string => file.path)).toEqual(["database/storage.sqlite"]);
  await assertMigrationSourcesUnchanged(sources);
  // 数据库取迁移产物，配置与其余数据原样沿用停机备份；完成清单留在产物目录。
  // SQLite 只替换主库文件，停机备份里的 WAL/SHM 已并入产物，不随部署。
  await copyFixtureTree(config, deployedConfig);
  await mkdir(join(deployedData, "database"));
  await Bun.write(join(deployedData, "database/storage.sqlite"), Bun.file(join(databaseOutput, "database/storage.sqlite")));
  for (const name of ["memory", "logs"]) await copyFixtureTree(join(data, name), join(deployedData, name));
  chmodSync(join(deployedData, "database"), 0o2770);
  chmodSync(join(deployedData, "database/storage.sqlite"), 0o660);
  return { config: deployedConfig, data: deployedData, database, sources };
}

/** 模拟运维按清单替换后的目录，显式恢复 SQLite 协作权限，再交给真实安装器。 */
export async function deployMigratedFixture(migrated: MigratedDeployment, config: string, data: string): Promise<void> {
  await copyFixtureTree(migrated.config, config);
  await copyFixtureTree(migrated.data, data);
  for (const path of SECRET_CONFIG_FILES) chmodSync(join(config, path), 0o600);
  chmodSync(join(data, "database"), 0o2770);
  chmodSync(join(data, "database/storage.sqlite"), 0o660);
  assertMigratedDatabase(join(data, "database/storage.sqlite"), migrated.database);
}

/** 校验备份正文、权限、属主与链接拓扑，数据库源快照从未以 SQLite 方式打开。 */
export async function assertMigrationSourcesUnchanged(sources: readonly MigrationFileSnapshot[]): Promise<void> {
  for (const source of sources) expect(await readMigrationFileSnapshot(source.path)).toEqual(source);
}
