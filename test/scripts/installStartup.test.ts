import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openStorageDatabase } from "../../packages/database/interact/connection";
import { seedStorageDatabase } from "../../scripts/fixtures/storageDatabase";
import {
  cleanupFixtures,
  createFixture,
  readText,
  runInstaller,
  systemdPrompt,
  writeText,
} from "../../scripts/installIsolation/fixture";
import type { InstallerFixture, PromptReply } from "../../scripts/installIsolation/fixture";

afterEach(cleanupFixtures);

function firstInstallPrompts(ai: boolean): PromptReply[] {
  const prompts: PromptReply[] = [
    { prompt: "Telegram bot token", reply: "123456789:installation_test_token", secret: true },
    { prompt: "超级管理员用户 ID", reply: "123456789" },
    { prompt: "现在配置 AI 能力", reply: ai ? "y" : "n" },
  ];
  if (ai) {
    for (const capability of ["ad_detect", "text", "summary", "media", "image", "song"]) {
      const enabled: boolean = ["text", "summary", "media"].includes(capability);
      prompts.push({ prompt: `配置 ${capability}？`, reply: enabled ? "y" : "n" });
      if (enabled) {
        prompts.push(
          { prompt: `${capability} 的 provider`, reply: "google" },
          { prompt: `${capability} 的 api_key`, reply: "installation-test-api-key", secret: true },
          { prompt: `${capability} 的 model`, reply: "installation-test-model" }
        );
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
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBe(true);
  expect(await Bun.file(join(fixture.runtimeRoot, "state.json")).json()).toBeDefined();
  expect(await Bun.file(join(fixture.runtimeRoot, "bot.lock")).exists()).toBe(false);
  expect(await Bun.file(join(fixture.worktree, "state.json")).exists()).toBe(false);
  expect(await readText(fixture.outboundLog)).not.toContain(":blocked");
}

describe("install.sh 到真实应用启动", () => {
  test.each([false, true])("新安装、正常配置与重启（AI=%s）", async (ai: boolean): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    const first = runInstaller(fixture, firstInstallPrompts(ai));
    expect(first.exitCode, first.output).toBe(0);
    await assertInstalledStartup(fixture, first.output, ai);

    const telegram: string = await readText(join(fixture.configRoot, "telegram.json"));
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
    expect(await readText(join(fixture.configRoot, "telegram.json"))).toBe(telegram);
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
    expect(await readText(join(fixture.configRoot, "stickers.json"))).toBe("{}\n");
  }, 30_000);
});
