import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import { IDENTITY_DATABASE_SCHEMA_VERSION, IDENTITY_DATABASE_TIME_ZONE_KEY } from "../../packages/consts/identityStorage";
import { closeStorageDatabase, openStorageDatabase } from "../../packages/database/interact/connection";
import { initializeStorageDatabase } from "../../packages/database/interact/initialization";
import { createStorageDatabase } from "../../packages/database/interact/migration";
import type { StorageDatabase } from "../../packages/types/storageDatabase";
import { readMigrationFileSnapshot } from "../../scripts/fixtures/migrationFiles";
import type { MigrationFileSnapshot } from "../../scripts/fixtures/migrationFiles";
import {
  PRESERVED_MIGRATION_CONFIG_FILES, assertMigrationSourcesUnchanged, deployMigratedFixture, prepareMigratedDeployment,
} from "../../scripts/fixtures/migrationDeployment";
import { createMigrationDatabase } from "../../scripts/fixtures/migrationDatabase";
import type { MigratedDeployment } from "../../scripts/fixtures/migrationDeployment";
import { cleanupFixtures, createFixture, runInstaller, systemdPrompt, writeText } from "../../scripts/installIsolation/fixture";
import type { InstallerFixture, InstallerRunResult } from "../../scripts/installIsolation/fixture";

afterEach(cleanupFixtures);

test("仍是 12.1.0 身份入口时安装器拒绝启动并指向 13.x 分阶段升级，不创建新身份或数据库", async (): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  const path: string = join(fixture.configRoot, "telegram.json");
  await Bun.write(path, JSON.stringify({ bot_token: "123456789:old_test_token", super_admin_user_id: 123456789 }));
  const before: MigrationFileSnapshot | null = await readMigrationFileSnapshot(path);
  const result: InstallerRunResult = await runInstaller(fixture, []);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("先安装 13.x 发行版");
  expect(result.output).not.toContain("INSTALL_API");
  expect(await readMigrationFileSnapshot(path)).toEqual(before);
  expect(await Bun.file(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json")).exists()).toBeFalse();
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBeFalse();
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain("systemctl:guarded:start");
}, 30_000);

test.each(["state.json", "state.json.bak"])("数据根仍有 14.x 的 %s 时安装器拒绝启动并提示先升级到 16.3.2，不改写状态或创建数据库", async (name: string): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  const path: string = join(fixture.runtimeRoot, name);
  await Bun.write(path, JSON.stringify({ global: { copy: { copiedUser: null } } }));
  const before: MigrationFileSnapshot | null = await readMigrationFileSnapshot(path);
  const result: InstallerRunResult = await runInstaller(fixture, []);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("先升级到 16.3.2");
  expect(result.output).not.toContain("migrate:global-state");
  expect(result.output).not.toContain("INSTALL_API");
  expect(await readMigrationFileSnapshot(path)).toEqual(before);
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBeFalse();
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain("systemctl:guarded:start");
}, 30_000);

test("memory/global/state.json 仍是总计数 ttsUsage 时安装器在启动前拒绝并提示先升级到 16.3.2，不改写状态或创建数据库", async (): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  const path: string = join(fixture.runtimeRoot, "memory/global/state.json");
  await Bun.write(path, JSON.stringify({ copy: { copiedUser: null }, ttsUsage: { windowStartedAt: 1_000, count: 10 } }));
  const before: MigrationFileSnapshot | null = await readMigrationFileSnapshot(path);
  const result: InstallerRunResult = await runInstaller(fixture, []);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("memory/global/state.json: $.ttsUsage.<key> must be absent");
  expect(result.output).toContain("先升级到 16.3.2");
  expect(result.output).not.toContain("migrate:global-state");
  expect(result.output).not.toContain("配置校验通过");
  expect(result.output).not.toContain("INSTALL_API");
  expect(await readMigrationFileSnapshot(path)).toEqual(before);
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBeFalse();
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain("systemctl:guarded:start");
}, 30_000);

test("数据库仍是 schema v11 时安装器在启动前拒绝并提示冷迁移，不改写数据库", async (): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  await createMigrationDatabase({ packageRoot: join(import.meta.dir, "../.."), root: fixture.root, source: fixture.runtimeRoot });
  const path: string = join(fixture.runtimeRoot, "database/storage.sqlite");
  const before: MigrationFileSnapshot | null = await readMigrationFileSnapshot(path);
  const result: InstallerRunResult = await runInstaller(fixture, []);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain(`storage_metadata.schema-version must be {"version":${IDENTITY_DATABASE_SCHEMA_VERSION}}`);
  expect(result.output).toContain("migrate:chat-persona-removal");
  expect(result.output).not.toContain("配置校验通过");
  expect(result.output).not.toContain("INSTALL_API");
  expect(await readMigrationFileSnapshot(path)).toEqual(before);
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain("systemctl:guarded:start");
}, 30_000);

test("已有数据库绑定的时区与 bot.json 不一致时安装器在注册服务前拒绝，不改写数据库", async (): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
  await writeText(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json"), JSON.stringify({
    bot_token: "123456789:existing_test_token", super_admin_user_id: 123456789, time_zone: "UTC",
  }), 0o600);
  const path: string = join(fixture.runtimeRoot, "database/storage.sqlite");
  mkdirSync(dirname(path), { mode: 0o770 });
  createStorageDatabase(path);
  const database: StorageDatabase = openStorageDatabase({ path });
  try {
    initializeStorageDatabase(database, "Asia/Seoul");
  } finally {
    closeStorageDatabase(database);
  }
  const before: MigrationFileSnapshot | null = await readMigrationFileSnapshot(path);
  const result: InstallerRunResult = await runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "n" },
    { prompt: "现在配置 AI 能力", reply: "n", optional: true },
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain(`storage_metadata.${IDENTITY_DATABASE_TIME_ZONE_KEY} must be ${JSON.stringify({ timeZone: "UTC" })}`);
  expect(result.output).toContain("已有数据根不支持更换时区");
  expect(result.output).not.toContain("配置校验通过");
  expect(result.output).not.toContain("INSTALL_API");
  expect(await readMigrationFileSnapshot(path)).toEqual(before);
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain("systemctl:guarded:start");
}, 30_000);

test("16.3.2 格式 mock 备份经源码冷迁移、安装与真实启动保留业务数据、全局状态、空字符串身份与配置", async (): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  const migrated: MigratedDeployment = await prepareMigratedDeployment({
    packageRoot: join(import.meta.dir, "../.."), root: join(fixture.root, "migration"),
  });
  await deployMigratedFixture(migrated, fixture.configRoot, fixture.runtimeRoot);
  const path: string = join(fixture.runtimeRoot, "database/storage.sqlite");
  const result: InstallerRunResult = await runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "n" }, systemdPrompt(),
  ]);
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toContain("配置校验通过");
  expect(result.output).toContain("Bot started as @installation_test_bot");
  expect(result.output).toContain("Restored state for 1 chat(s), currently copying 42.");
  expect(result.output).toContain("INSTALL_API getUpdates");
  expect(result.output).toContain("Received SIGTERM; beginning graceful shutdown.");
  expect(result.output).toContain('INSTALL_WORKERS ["aiChatWorker.ts","antiRaidWorker.ts","diskIOWorker.ts"]');
  expect(result.output).not.toContain("INSTALL_NETWORK_BLOCKED");
  expect(result.output).not.toContain("Unhandled error");
  expect(result.output).not.toContain("Shutdown drain/flush results:");
  expect(result.output).not.toContain("/translate 翻译不可用");
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain(":blocked");
  expect(await Bun.file(join(fixture.runtimeRoot, "bot.lock")).exists()).toBeFalse();
  expect(await Bun.file(join(fixture.runtimeRoot, "memory/wed/-1001.json")).json()).toEqual([42, 43]);
  expect(await Bun.file(join(fixture.runtimeRoot, "memory/global/state.json")).text())
    .toBe(await Bun.file(join(migrated.data, "memory/global/state.json")).text());
  expect(await Bun.file(join(fixture.runtimeRoot, "state.json")).exists()).toBeFalse();
  for (const name of PRESERVED_MIGRATION_CONFIG_FILES) {
    expect((await readMigrationFileSnapshot(join(fixture.configRoot, name)))?.sha256)
      .toBe((await readMigrationFileSnapshot(join(migrated.config, name)))?.sha256);
  }
  const client: Database = new Database(path, { readonly: true });
  try {
    expect(client.query("SELECT q, json(data) AS data FROM chat_qa").all()).toEqual([{ q: "迁移问题", data: '{"a":"保留答案"}' }]);
    expect(client.query("SELECT chat_id, json(ai_context) AS context FROM chat_states").all()).toEqual([{
      chat_id: -1001,
      context: JSON.stringify({ version: 1, buffer: [], summaries: ["迁移前的上下文"], pendingSummary: null, savedAt: 1 }),
    }]);
    const status: { readonly translate: string } | null = client.query<{ readonly translate: string }, []>(
      "SELECT json_extract(json(status), '$.translate') AS translate FROM chat_states"
    ).get();
    expect(JSON.parse(status?.translate ?? "null")).toEqual([
      { translatedUser: { id: 7, username: "", first_name: "", last_name: "" }, language: "ja" },
    ]);
  } finally { client.close(true); }
  await assertMigrationSourcesUnchanged(migrated.sources);
}, 60_000);
