import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readBotMigrationFile } from "../../scripts/migrations/botConfig/files";
import type { BotMigrationFile } from "../../scripts/migrations/botConfig/files";
import { assertMigrationSourcesUnchanged, deployMigratedFixture, prepareMigratedDeployment } from "../../scripts/fixtures/migrationDeployment";
import type { MigratedDeployment } from "../../scripts/fixtures/migrationDeployment";
import { cleanupFixtures, createFixture, runInstaller, systemdPrompt } from "../../scripts/installIsolation/fixture";
import type { InstallerFixture, InstallerRunResult } from "../../scripts/installIsolation/fixture";

afterEach(cleanupFixtures);

test("未手工替换 12.1.0 身份入口时安装器拒绝启动，不创建新身份或数据库", async (): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  const path: string = join(fixture.configRoot, "telegram.json");
  await Bun.write(path, JSON.stringify({ bot_token: "123456789:old_test_token", super_admin_user_id: 123456789 }));
  const before: BotMigrationFile | null = await readBotMigrationFile(path);
  const result: InstallerRunResult = runInstaller(fixture, []);
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toContain("migrate:bot-config");
  expect(result.output).not.toContain("INSTALL_API");
  expect(await readBotMigrationFile(path)).toEqual(before);
  expect(await Bun.file(join(fixture.configRoot, "bot.json")).exists()).toBeFalse();
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBeFalse();
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain("systemctl:guarded:start");
}, 30_000);

test.each([false, true])("12.1.0 mock 备份经源码冷迁移、安装与真实启动保留业务数据（历史谱系=%s）", async (historical: boolean): Promise<void> => {
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
  expect(result.output).toContain("Restored state for 1 chat(s).");
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
  for (const name of ["agent.json", "ad_samples.json", "mood.json", "stickers.json", "reactions.json"]) {
    expect(await Bun.file(join(fixture.configRoot, name)).text()).toBe(await Bun.file(join(migrated.config, name)).text());
  }
  expect((await readBotMigrationFile(join(fixture.configRoot, "g-auth.json")))?.sha256)
    .toBe((await readBotMigrationFile(join(migrated.config, "g-auth.json")))?.sha256);
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
