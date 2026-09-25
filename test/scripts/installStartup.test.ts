import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { openStorageDatabase } from "../../packages/database/interact/connection";
import { seedStorageDatabase } from "../../scripts/fixtures/storageDatabase";
import {
  cleanupFixtures,
  createFixture,
  runInstaller,
  systemdPrompt,
  writeText,
} from "../../scripts/installIsolation/fixture";
import type { InstallerFixture, InstallerRunResult, PromptReply } from "../../scripts/installIsolation/fixture";

afterEach(cleanupFixtures);

function firstInstallPrompts(ai: boolean): PromptReply[] {
  const prompts: PromptReply[] = [
    { prompt: "Telegram bot token", reply: "123456789:installation_test_token", secret: true },
    { prompt: "超级管理员用户 ID", reply: "123456789" },
    { prompt: "现在配置 AI 能力", reply: ai ? "y" : "n" },
  ];
  if (ai) {
    for (const capability of ["ad_detect", "text", "summary", "media", "image", "tts"]) {
      const enabled: boolean = ["text", "summary", "media", "tts"].includes(capability);
      prompts.push({ prompt: `配置 ${capability}？`, reply: enabled ? "y" : "n" });
      if (enabled) {
        prompts.push(
          { prompt: `${capability} 的 provider`, reply: "google" },
          { prompt: `${capability} 的 api_key`, reply: "installation-test-api-key", secret: true },
          { prompt: `${capability} 的 model`, reply: "installation-test-model" }
        );
        if (capability === "tts") prompts.push({ prompt: "tts 的 voice", reply: "Leda" });
      }
    }
  }
  prompts.push(systemdPrompt());
  return prompts;
}

async function assertInstalledStartup(fixture: InstallerFixture, output: string, ai: boolean): Promise<void> {
  expect(output).toContain("配置校验通过");
  expect(output).toContain("Bot started as @installation_test_bot");
  expect(output).toContain("INSTALL_API getUpdates");
  expect(output).toContain("Received SIGTERM; beginning graceful shutdown.");
  expect(output).not.toContain("Unhandled error");
  expect(output).not.toContain("Shutdown drain/flush results:");
  expect(output).not.toContain("INSTALL_NETWORK_BLOCKED");
  expect(output.match(/^INSTALL_WORKER_NETWORK_GUARD\r?$/gm)?.length).toBe(ai ? 3 : 2);
  if (ai) expect(output).toContain("INSTALL_WEATHER_MOCK");
  else expect(output).not.toContain("INSTALL_WEATHER_MOCK");
  expect(output).toContain(`INSTALL_WORKERS ${JSON.stringify(
    (ai ? ["aiChatWorker.ts", "antiRaidWorker.ts", "diskIOWorker.ts"] : ["antiRaidWorker.ts", "diskIOWorker.ts"])
  )}`);
  if (ai) {
    const agent: { readonly agent: Readonly<Record<string, Readonly<Record<string, unknown>>>> } =
      await Bun.file(join(fixture.configRoot, "agent.json")).json();
    expect(agent.agent.tts).toMatchObject({ provider: "google", model: "installation-test-model", voice: "Leda" });
  }
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBe(true);
  expect(await Bun.file(join(fixture.runtimeRoot, "state.json")).json()).toBeDefined();
  expect(await Bun.file(join(fixture.runtimeRoot, "bot.lock")).exists()).toBe(false);
  expect(await Bun.file(join(fixture.worktree, "state.json")).exists()).toBe(false);
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain(":blocked");
}

describe("install.sh 到真实应用启动", () => {
  test("重填 Bot 身份时保留指向外部 telegram.json 的链接、权限和普通语气", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    mkdirSync(fixture.configRoot);
    const external: string = join(fixture.root, "external-secrets");
    mkdirSync(external);
    const target: string = join(external, "telegram.json");
    const entry: string = join(fixture.configRoot, "bot.json");
    await writeText(target, JSON.stringify({
      bot_token: "123456789:existing_test_token", super_admin_user_id: 123456789, atmosphere: "normal",
    }), 0o640);
    symlinkSync(target, entry);
    const original: ReturnType<typeof statSync> = statSync(target);
    const result: InstallerRunResult = runInstaller(fixture, [
      { prompt: "是否重新填写？", reply: "y" },
      { prompt: "Telegram bot token", reply: "987654321:replacement_test_token", secret: true },
      { prompt: "超级管理员用户 ID", reply: "987654321" },
      { prompt: "现在配置 AI 能力", reply: "n", optional: true },
      systemdPrompt(),
    ]);
    expect(result.exitCode, result.output).toBe(0);
    await assertInstalledStartup(fixture, result.output, false);
    expect(lstatSync(entry).isSymbolicLink()).toBeTrue();
    expect(await Bun.file(target).json()).toEqual({
      bot_token: "987654321:replacement_test_token", super_admin_user_id: 987654321, atmosphere: "normal",
    });
    const replaced: ReturnType<typeof statSync> = statSync(target);
    expect(replaced.mode).toBe(original.mode);
    expect(replaced.uid).toBe(original.uid);
    expect(replaced.gid).toBe(original.gid);
  }, 30_000);

  test.each([false, true])("新安装、正常配置与重启（AI=%s）", async (ai: boolean): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    const first = runInstaller(fixture, firstInstallPrompts(ai));
    expect(first.exitCode, first.output).toBe(0);
    await assertInstalledStartup(fixture, first.output, ai);

    const telegram: string = await Bun.file(join(fixture.configRoot, "bot.json")).text();
    const database = openStorageDatabase({ path: join(fixture.runtimeRoot, "database/storage.sqlite") });
    try {
      seedStorageDatabase(database, {
        metadata: [], whitelist: [], blocklist: [], removals: [],
        chatStates: [{ chatId: -1001, data: JSON.stringify({ isInitEnabled: true, isAIChatEnabled: ai }), aiPersona: "fixture persona" }],
      });
    } finally { database.$client.close(true); }
    const prompts: PromptReply[] = [{ prompt: "是否重新填写？", reply: "n" }];
    if (!ai) prompts.push({ prompt: "现在配置 AI 能力", reply: "n" });
    prompts.push(systemdPrompt());
    const second = runInstaller(fixture, prompts);
    expect(second.exitCode, second.output).toBe(0);
    await assertInstalledStartup(fixture, second.output, ai);
    expect(second.output).toContain("Restored state for 1 chat(s).");
    expect(second.output).toContain("INSTALL_API getChat");
    expect(await Bun.file(join(fixture.configRoot, "bot.json")).text()).toBe(telegram);
  }, 60_000);

  test("存在但非法的可选配置在启动之前拒绝", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    await writeText(join(fixture.configRoot, "stickers.json"), "{}\n");
    const result = runInstaller(fixture, firstInstallPrompts(false));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("stickers.json: $ must be");
    expect(result.output).not.toContain("INSTALL_API");
    expect(result.output).not.toContain("Bot started");
    expect(await Bun.file(join(fixture.runtimeRoot, "state.json")).exists()).toBe(false);
    expect(await Bun.file(join(fixture.configRoot, "stickers.json")).text()).toBe("{}\n");
  }, 30_000);
});
