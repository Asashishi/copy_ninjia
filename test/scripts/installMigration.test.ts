import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import { readMigrationFileSnapshot } from "../../scripts/fixtures/migrationFiles";
import type { MigrationFileSnapshot } from "../../scripts/fixtures/migrationFiles";
import { assertMigrationSourcesUnchanged, deployMigratedFixture, prepareMigratedDeployment } from "../../scripts/fixtures/migrationDeployment";
import type { MigratedDeployment } from "../../scripts/fixtures/migrationDeployment";
import { cleanupFixtures, createFixture, runInstaller, systemdPrompt } from "../../scripts/installIsolation/fixture";
import type { InstallerFixture, InstallerRunResult } from "../../scripts/installIsolation/fixture";

afterEach(cleanupFixtures);

test("仍是 12.1.0 身份入口时安装器拒绝启动并指向 13.x 分阶段升级，不创建新身份或数据库", async (): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  const path: string = join(fixture.configRoot, "telegram.json");
  await Bun.write(path, JSON.stringify({ bot_token: "123456789:old_test_token", super_admin_user_id: 123456789 }));
  const before: MigrationFileSnapshot | null = await readMigrationFileSnapshot(path);
  const result: InstallerRunResult = runInstaller(fixture, []);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("先安装 13.x 发行版");
  expect(result.output).not.toContain("INSTALL_API");
  expect(await readMigrationFileSnapshot(path)).toEqual(before);
  expect(await Bun.file(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json")).exists()).toBeFalse();
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBeFalse();
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain("systemctl:guarded:start");
}, 30_000);

test.each(["state.json", "state.json.bak"])("数据根仍有 14.x 的 %s 时安装器拒绝启动并提示冷迁移，不改写状态或创建数据库", async (name: string): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  const path: string = join(fixture.runtimeRoot, name);
  await Bun.write(path, JSON.stringify({ global: { copy: { copiedUser: null } } }));
  const before: MigrationFileSnapshot | null = await readMigrationFileSnapshot(path);
  const result: InstallerRunResult = runInstaller(fixture, []);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("migrate:global-state");
  expect(result.output).not.toContain("INSTALL_API");
  expect(await readMigrationFileSnapshot(path)).toEqual(before);
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBeFalse();
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain("systemctl:guarded:start");
}, 30_000);

test.each([false, true])("14.x mock 备份经源码冷迁移、安装与真实启动保留业务数据、全局状态与素材配置（历史谱系=%s）", async (historical: boolean): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  const migrated: MigratedDeployment = await prepareMigratedDeployment({
    packageRoot: join(import.meta.dir, "../.."), root: join(fixture.root, "migration"), historical,
  });
  await deployMigratedFixture(migrated, fixture.configRoot, fixture.runtimeRoot);
  const path: string = join(fixture.runtimeRoot, "database/storage.sqlite");
  const result: InstallerRunResult = runInstaller(fixture, [
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
  for (const name of [
    join(DYNAMIC_CONFIG_DIR_NAME, "agent.json"),
    join(DYNAMIC_CONFIG_DIR_NAME, "ad_samples.json"),
    join(DYNAMIC_CONFIG_DIR_NAME, "mood.json"),
    join(DYNAMIC_CONFIG_DIR_NAME, "stickers.json"),
    "reactions.json",
    join(DYNAMIC_CONFIG_DIR_NAME, "assets.json"),
  ]) {
    expect(await Bun.file(join(fixture.configRoot, name)).text()).toBe(await Bun.file(join(migrated.config, name)).text());
  }
  expect((await readMigrationFileSnapshot(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "g-auth.json")))?.sha256)
    .toBe((await readMigrationFileSnapshot(join(migrated.config, STATIC_CONFIG_DIR_NAME, "g-auth.json")))?.sha256);
  const client: Database = new Database(path, { readonly: true });
  try {
    expect(client.query("SELECT q, json(data) AS data FROM chat_qa").all()).toEqual([{ q: "迁移问题", data: '{"a":"保留答案"}' }]);
    expect(client.query("SELECT ai_persona, json(ai_context) AS context FROM chat_states").get()).toEqual({
      ai_persona: "迁移前的本群人设",
      context: JSON.stringify({ version: 1, buffer: [], summaries: ["迁移前的上下文"], pendingSummary: null, savedAt: 1 }),
    });
  } finally { client.close(true); }
  await assertMigrationSourcesUnchanged(migrated.sources);
}, 60_000);
