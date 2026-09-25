/** 源码与二进制共用的冷迁移端到端验证；全部路径归调用方的独立临时根所有。 */
import { expect } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ACTIVE_COLD_MIGRATION_EDGES } from "../migrations/active";
import { copyFixtureTree } from "./copyTree";
import { googleAuthFixture } from "./googleAuth";
import { createMigrationDatabase, assertMigratedDatabase, MIGRATION_FIXTURE_CHAT_ID } from "./migrationDatabase";
import type { MigrationDatabaseFixture } from "./migrationDatabase";
import { readMigrationFileSnapshot } from "./migrationFiles";
import type { MigrationFileSnapshot } from "./migrationFiles";
import type { RandomImageNameMigrationResult } from "../migrateRandomImageNames";
import type { TranslateSessionsMigrationResult } from "../migrateTranslateSessions";

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
  readonly translate: ReadonlyMap<number, unknown>;
  readonly sources: readonly MigrationFileSnapshot[];
}

/** 当前配置目录里的 Bot 身份，与安装器夹具的 API 桩一致。 */
const BOT_IDENTITY: Readonly<Record<string, unknown>> = {
  bot_token: "123456789:migration_test_token",
  super_admin_user_id: 123456789,
  atmosphere: "mesugaki",
};

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
  const sessions: readonly unknown[] = [{ translatedUser: { id: 42, first_name: "翻译身份" }, language: "en" }];
  const global: Readonly<Record<string, unknown>> = {
    copy: { copiedUser: null, lastCopyTime: 12 },
    assets: { randomHImageDir: deployedImages, fortuneThumbnailUrl: "https://example.com/fortune.png" },
  };
  const state: Readonly<Record<string, unknown>> = { global, translate: { [String(MIGRATION_FIXTURE_CHAT_ID)]: sessions } };
  const backupGlobal: Readonly<Record<string, unknown>> = { copy: { copiedUser: null, lastCopyTime: 6 } };
  const backup: Readonly<Record<string, unknown>> = { global: backupGlobal };
  await Bun.write(join(data, "state.json"), JSON.stringify(state));
  await Bun.write(join(data, "state.json.bak"), JSON.stringify(backup));
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
    "migrate:translate-sessions": ["--source-root", data],
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
  const stateOutput: string = outputs.get("migrate:translate-sessions")!;
  const stateResult: TranslateSessionsMigrationResult = await Bun.file(join(stateOutput, "ready.json")).json() as TranslateSessionsMigrationResult;
  expect([stateResult.migratedChats, stateResult.migratedSessions, stateResult.createdChatRows]).toEqual([1, 1, 0]);
  expect(await Bun.file(join(stateOutput, "state.json")).json()).toEqual({ global });
  expect(await Bun.file(join(stateOutput, "state.json.bak")).json()).toEqual({ global: backupGlobal });
  const translate: ReadonlyMap<number, unknown> = new Map([[MIGRATION_FIXTURE_CHAT_ID, sessions]]);
  assertMigratedDatabase(join(stateOutput, "database/storage.sqlite"), database, translate);
  const imageOutput: string = outputs.get("migrate:random-image-names")!;
  const imageResult: RandomImageNameMigrationResult = await Bun.file(join(imageOutput, "ready.json")).json() as RandomImageNameMigrationResult;
  expect([imageResult.renamed, imageResult.deduplicated, imageResult.outputFiles.length]).toEqual([1, 1, 1]);
  for (const file of imageResult.outputFiles) {
    expect(file.name).toBe(`${new Bun.CryptoHasher("sha256").update(image).digest("hex")}.png`);
    expect(await Bun.file(join(imageOutput, file.name)).bytes()).toEqual(image);
    await Bun.write(join(deployedImages, file.name), Bun.file(join(imageOutput, file.name)));
  }
  await assertMigrationSourcesUnchanged(sources);
  // 只组装清单对应的部署文件；完成清单及旧 WAL/SHM 留在备份、产物目录。
  await copyFixtureTree(config, deployedConfig);
  for (const name of ["bot.json", "agent.json", "g-auth.json"]) chmodSync(join(deployedConfig, name), 0o600);
  for (const name of ["state.json", "state.json.bak"]) await Bun.write(join(deployedData, name), Bun.file(join(stateOutput, name)));
  await mkdir(join(deployedData, "database"), { recursive: true });
  await Bun.write(join(deployedData, "database/storage.sqlite"), Bun.file(join(stateOutput, "database/storage.sqlite")));
  for (const name of ["memory", "logs"]) await copyFixtureTree(join(data, name), join(deployedData, name));
  chmodSync(join(deployedData, "database"), 0o2770);
  chmodSync(join(deployedData, "database/storage.sqlite"), 0o660);
  return { config: deployedConfig, data: deployedData, database, translate, sources };
}

/** 模拟运维按清单替换后的目录，显式恢复 SQLite 协作权限，再交给真实安装器。 */
export async function deployMigratedFixture(migrated: MigratedDeployment, config: string, data: string): Promise<void> {
  await copyFixtureTree(migrated.config, config);
  await copyFixtureTree(migrated.data, data);
  for (const name of ["bot.json", "agent.json", "g-auth.json"]) chmodSync(join(config, name), 0o600);
  chmodSync(join(data, "database"), 0o2770);
  chmodSync(join(data, "database/storage.sqlite"), 0o660);
  assertMigratedDatabase(join(data, "database/storage.sqlite"), migrated.database, migrated.translate);
}

/** 校验备份正文、权限、属主与链接拓扑，数据库源快照从未以 SQLite 方式打开。 */
export async function assertMigrationSourcesUnchanged(sources: readonly MigrationFileSnapshot[]): Promise<void> {
  for (const source of sources) expect(await readMigrationFileSnapshot(source.path)).toEqual(source);
}
