/** 源码与二进制共用的冷迁移端到端验证；全部路径归调用方的独立临时根所有。 */
import { expect } from "bun:test";
import { chmodSync, renameSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import { ACTIVE_COLD_MIGRATION_EDGES } from "../migrations/active";
import { copyFixtureTree } from "./copyTree";
import { googleAuthFixture } from "./googleAuth";
import { createMigrationDatabase, assertMigratedDatabase } from "./migrationDatabase";
import type { MigrationDatabaseFixture } from "./migrationDatabase";
import { readMigrationFileSnapshot } from "./migrationFiles";
import type { MigrationFileSnapshot } from "./migrationFiles";
import type { RandomImageNameMigrationResult } from "../migrateRandomImageNames";
import type { GlobalStateMigrationResult } from "../migrateGlobalState";

export interface MigrationDeploymentOptions {
  readonly packageRoot: string;
  readonly root: string;
  readonly binary?: boolean;
  /** 源库使用历史 Drizzle 谱系（TEXT 与 JSONB 两条基础迁移）。 */
  readonly historical?: boolean;
}

export interface MigratedDeployment {
  readonly config: string;
  readonly data: string;
  readonly database: MigrationDatabaseFixture;
  readonly sources: readonly MigrationFileSnapshot[];
}

/** 当前配置目录里的 Bot 身份，与安装器夹具的 API 桩一致。 */
const BOT_IDENTITY: Readonly<Record<string, unknown>> = {
  bot_token: "123456789:migration_test_token",
  super_admin_user_id: 123456789,
  atmosphere: "mesugaki",
};

/** 源备份里平铺的部署文件在当前布局下所属的子目录；其余文件（如旧 reactions.json）留在配置根顶层。 */
const CONFIG_FILE_DIRECTORIES: Readonly<Record<string, string>> = {
  "bot.json": STATIC_CONFIG_DIR_NAME,
  "g-auth.json": STATIC_CONFIG_DIR_NAME,
  "agent.json": DYNAMIC_CONFIG_DIR_NAME,
  "ad_samples.json": DYNAMIC_CONFIG_DIR_NAME,
  "stickers.json": DYNAMIC_CONFIG_DIR_NAME,
  "mood.json": DYNAMIC_CONFIG_DIR_NAME,
};

/** 含凭据、须保持 0600 的部署文件在当前布局下的相对路径。 */
const SECRET_CONFIG_FILES: readonly string[] = [
  join(STATIC_CONFIG_DIR_NAME, "bot.json"),
  join(DYNAMIC_CONFIG_DIR_NAME, "agent.json"),
  join(STATIC_CONFIG_DIR_NAME, "g-auth.json"),
];

/** 模拟运维停机后把平铺的旧配置按当前布局手工移入 static/ 与 dynamic/。 */
async function assembleConfigLayout(source: string, target: string): Promise<void> {
  await copyFixtureTree(source, target);
  for (const directory of [STATIC_CONFIG_DIR_NAME, DYNAMIC_CONFIG_DIR_NAME]) await mkdir(join(target, directory));
  for (const [name, directory] of Object.entries(CONFIG_FILE_DIRECTORIES)) {
    renameSync(join(target, name), join(target, directory, name));
  }
  for (const path of SECRET_CONFIG_FILES) chmodSync(join(target, path), 0o600);
}

/** 建立完整 mock 备份，执行实际 CLI，核对拒绝覆盖与源哈希，再按清单组装部署目录。 */
export async function prepareMigratedDeployment({
  packageRoot, root, binary = false, historical = false,
}: MigrationDeploymentOptions): Promise<MigratedDeployment> {
  await mkdir(root);
  const config: string = join(root, "source config");
  const data: string = join(root, "source data");
  const images: string = join(root, "source images");
  const deployment: string = join(root, "deployment");
  const deployedConfig: string = join(deployment, "config");
  const deployedData: string = join(deployment, "data");
  const deployedImages: string = join(deployedData, "h_image");
  for (const directory of [config, data, images, deployedConfig, deployedData, deployedImages]) await mkdir(directory, { recursive: true });
  await Bun.write(join(config, "bot.json"), JSON.stringify(BOT_IDENTITY));
  await Bun.write(join(config, "g-auth.json"), await googleAuthFixture());
  await Bun.write(join(config, "agent.json"), JSON.stringify({ agent: {
    text: { provider: "openai", api_key: "migration-test-key", model: "test" },
    summary: { provider: "openai", api_key: "migration-test-key", model: "test" },
    media: { provider: "openai", api_key: "migration-test-key", model: "test" },
  } }));
  for (const name of ["bot.json", "agent.json", "g-auth.json"]) chmodSync(join(config, name), 0o600);
  await Bun.write(join(config, "reactions.json"), JSON.stringify({ emotionKeywords: { "👍": ["迁移反应"] } }));
  await Bun.write(join(config, "ad_samples.json"), JSON.stringify(["迁移前的广告示例"]));
  await Bun.write(join(config, "stickers.json"), JSON.stringify({ packs: [] }));
  await Bun.write(join(config, "mood.json"), JSON.stringify({ moods: [{ name: "迁移心情", weight: 100, instruction: "迁移前的心情指令" }] }));
  const copy: Readonly<Record<string, unknown>> = { copiedUser: { id: 42, first_name: "复读目标" }, copyChatId: -1001, lastCopyTime: 12 };
  // 14.x 的 state.json：素材目录与一条直链偏离内置缺省，另一条与缺省相同（迁移不写它）。
  const state: string = JSON.stringify({ global: {
    copy,
    assets: {
      randomHImageDir: deployedImages,
      fortuneThumbnailUrl: " https://example.com/fortune.png ",
      gagThumbnailUrl: "https://drive.google.com/uc?export=view&id=1AhvfdbcwQnUBBk86yEafb_G3gZOWXim2",
    },
  } }, null, 2);
  await Bun.write(join(data, "state.json"), state);
  await Bun.write(join(data, "state.json.bak"), state);
  await mkdir(join(data, "memory/wed"), { recursive: true });
  await Bun.write(join(data, "memory/wed/-1001.json"), "[42,43]");
  await mkdir(join(data, "logs"));
  await Bun.write(join(data, "logs/mock-history.json"), "[]");
  const image: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const name of ["0199ffff-ffff-7fff-bfff-ffffffffffff.png", "0199ffff-ffff-7fff-bfff-fffffffffffe-unique.png"]) {
    await Bun.write(join(images, name), image);
  }
  const database: MigrationDatabaseFixture = await createMigrationDatabase({ packageRoot, root, source: data, historical });
  const sources: MigrationFileSnapshot[] = [];
  for (const directory of [config, data, images]) {
    for await (const name of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true })) {
      sources.push((await readMigrationFileSnapshot(join(directory, name)))!);
    }
  }
  const guard: string = join(root, "no-outbound.js");
  await Bun.write(guard, [
    'globalThis.fetch = () => { throw new Error("MIGRATION_NETWORK_BLOCKED"); };',
    'globalThis.Worker = class { constructor() { throw new Error("MIGRATION_WORKER_BLOCKED"); } };',
  ].join("\n"));
  function run(args: readonly string[], success: boolean): string {
    const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
      cmd: [binary ? join(packageRoot, "copy-ninjia") : Bun.argv[0]!, "--preload", guard, ...args],
      cwd: root,
      env: { PATH: "/usr/bin:/bin", HOME: root, BUN_BE_BUN: "1", COPY_NINJIA_DATA_ROOT: data, COPY_NINJIA_CONFIG_ROOT: join(root, "absent-config") },
      stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL",
    });
    const output: string = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode === 0, output).toBe(success);
    expect(output).not.toMatch(/MIGRATION_(NETWORK|WORKER)_BLOCKED/);
    return output;
  }
  const argumentsByCommand: Readonly<Record<string, readonly string[]>> = {
    "migrate:random-image-names": ["--source-directory", images],
    "migrate:global-state": ["--source-root", data],
  };
  const outputs: Map<string, string> = new Map();
  for (const edge of ACTIVE_COLD_MIGRATION_EDGES) {
    const script: string = join(packageRoot, binary ? edge.bundledPath : edge.entryPath);
    expect(run([script, "--help"], true)).toContain(edge.command);
    run([script, "--unknown"], false);
    const output: string = join(root, edge.command.replaceAll(":", "-"));
    const outputFlag: string = edge.command === "migrate:random-image-names" ? "--output-directory" : "--output-root";
    const args: readonly string[] = [script, ...argumentsByCommand[edge.command]!, outputFlag, output];
    run(args, true);
    const ready: MigrationFileSnapshot | null = await readMigrationFileSnapshot(join(output, "ready.json"));
    if (ready === null) throw new Error(`Missing migration output: ${edge.command}`);
    expect(await Bun.file(join(output, "incomplete.json")).exists()).toBeFalse();
    run(args, false);
    expect(await readMigrationFileSnapshot(ready.path)).toEqual(ready);
    outputs.set(edge.command, output);
  }
  const stateOutput: string = outputs.get("migrate:global-state")!;
  const stateResult: GlobalStateMigrationResult = await Bun.file(join(stateOutput, "ready.json")).json() as GlobalStateMigrationResult;
  expect(stateResult.assetKeys).toEqual(["random_h_image_dir", "fortune_thumbnail_url"]);
  expect(await Bun.file(join(stateOutput, "memory/global/state.json")).json()).toEqual({ copy });
  expect(await Bun.file(join(stateOutput, "config/dynamic/assets.json")).json()).toEqual({
    random_h_image_dir: deployedImages,
    fortune_thumbnail_url: "https://example.com/fortune.png",
  });
  const imageOutput: string = outputs.get("migrate:random-image-names")!;
  const imageResult: RandomImageNameMigrationResult = await Bun.file(join(imageOutput, "ready.json")).json() as RandomImageNameMigrationResult;
  expect([imageResult.renamed, imageResult.deduplicated, imageResult.outputFiles.length]).toEqual([1, 1, 1]);
  for (const file of imageResult.outputFiles) {
    expect(file.name).toBe(`${new Bun.CryptoHasher("sha256").update(image).digest("hex")}.png`);
    expect(await Bun.file(join(imageOutput, file.name)).bytes()).toEqual(image);
    await Bun.write(join(deployedImages, file.name), Bun.file(join(imageOutput, file.name)));
  }
  await assertMigrationSourcesUnchanged(sources);
  // 只组装清单对应的部署文件：全局状态与素材配置取产物，数据库沿用停机备份的一致性快照（含 WAL/SHM），
  // 旧 state.json 与完成清单留在备份、产物目录。
  await assembleConfigLayout(config, deployedConfig);
  await Bun.write(join(deployedConfig, DYNAMIC_CONFIG_DIR_NAME, "assets.json"), Bun.file(join(stateOutput, "config/dynamic/assets.json")));
  await copyFixtureTree(join(data, "database"), join(deployedData, "database"));
  for (const name of ["memory", "logs"]) await copyFixtureTree(join(data, name), join(deployedData, name));
  await mkdir(join(deployedData, "memory/global"), { recursive: true });
  await Bun.write(join(deployedData, "memory/global/state.json"), Bun.file(join(stateOutput, "memory/global/state.json")));
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
