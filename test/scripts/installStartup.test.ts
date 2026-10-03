import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { AGENT_CAPABILITY_NAMES } from "../../packages/consts/agent";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import { Database } from "bun:sqlite";
import { openStorageDatabase } from "../../packages/database/interact/connection";
import { storageMetadataRows } from "../../packages/database/interact/initialization";
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
    for (const capability of AGENT_CAPABILITY_NAMES) {
      const enabled: boolean = ["text", "summary", "media", "tts"].includes(capability);
      prompts.push({ prompt: `配置 ${capability}？`, reply: enabled ? "y" : "n" });
      if (capability === "tts") {
        // xai 语音协议：问 speech_protocol、不问 model，openai provider 另问可留空的 base_url。
        prompts.push(
          { prompt: "tts 的 provider", reply: "openai" },
          { prompt: "tts 的 api_key", reply: "installation-test-api-key", secret: true },
          { prompt: "tts 的 speech_protocol", reply: "xai" },
          { prompt: "tts 的 base_url", reply: "" },
          { prompt: "tts 的 voice", reply: "ara" }
        );
      } else if (enabled) {
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
  if (ai) {
    const agent: { readonly agent: Readonly<Record<string, Readonly<Record<string, unknown>>>> } =
      await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "agent.json")).json();
    expect(agent.agent.tts).toEqual({
      provider: "openai",
      api_key: "installation-test-api-key",
      speech_protocol: "xai",
      voice: "ara",
    });
    expect(output).not.toContain("tts 的 model");
  }
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBe(true);
  // 全新部署没有需要持久化的全局状态，启动不写状态文件。
  expect(await Bun.file(join(fixture.runtimeRoot, "state.json")).exists()).toBe(false);
  expect(await Bun.file(join(fixture.runtimeRoot, "bot.lock")).exists()).toBe(false);
  expect(await Bun.file(join(fixture.worktree, "state.json")).exists()).toBe(false);
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain(":blocked");
}

describe("install.sh 到真实应用启动", () => {
  test("重填 Bot 身份时保留外部配置链接、权限、普通语气与默认时区", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
    const external: string = join(fixture.root, "external-secrets");
    mkdirSync(external);
    const target: string = join(external, "telegram.json");
    const entry: string = join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json");
    await writeText(target, JSON.stringify({
      bot_token: "123456789:existing_test_token", super_admin_user_id: 123456789, atmosphere: "normal", time_zone: "UTC",
    }), 0o640);
    symlinkSync(target, entry);
    const original: ReturnType<typeof statSync> = statSync(target);
    const result: InstallerRunResult = await runInstaller(fixture, [
      { prompt: "是否重新填写？", reply: "y" },
      { prompt: "Telegram bot token", reply: "987654321:replacement_test_token", secret: true },
      { prompt: "超级管理员用户 ID", reply: "987654321" },
      { prompt: "现在配置 AI 能力", reply: "n", optional: true },
      systemdPrompt(),
    ]);
    expect(result.exitCode, result.output).toBe(0);
    await assertInstalledStartup(fixture, result.output, false);
    // 新库绑定 bot.json 的时区，真实启动按同一时区通过时区闸。
    const client: Database = new Database(join(fixture.runtimeRoot, "database/storage.sqlite"), { readonly: true });
    try {
      expect<readonly unknown[]>(client.query("SELECT key, json(data) AS data FROM storage_metadata ORDER BY key").all())
        .toEqual(storageMetadataRows("UTC"));
    } finally { client.close(true); }
    expect(lstatSync(entry).isSymbolicLink()).toBeTrue();
    expect(await Bun.file(target).json()).toEqual({
      bot_token: "987654321:replacement_test_token", super_admin_user_id: 987654321, atmosphere: "normal", time_zone: "UTC",
    });
    const replaced: ReturnType<typeof statSync> = statSync(target);
    expect(replaced.mode).toBe(original.mode);
    expect(replaced.uid).toBe(original.uid);
    expect(replaced.gid).toBe(original.gid);
  }, 30_000);

  test.each([false, true])("新安装、正常配置与重启（AI=%s）", async (ai: boolean): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    const first = await runInstaller(fixture, firstInstallPrompts(ai));
    expect(first.exitCode, first.output).toBe(0);
    await assertInstalledStartup(fixture, first.output, ai);

    const telegram: string = await Bun.file(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json")).text();
    const database = openStorageDatabase({ path: join(fixture.runtimeRoot, "database/storage.sqlite") });
    try {
      seedStorageDatabase(database, {
        metadata: [], whitelist: [], blocklist: [], removals: [],
        chatStates: [{ chatId: -1001, data: JSON.stringify({ isInitEnabled: true, isAIChatEnabled: ai }) }],
      });
    } finally { database.$client.close(true); }
    const prompts: PromptReply[] = [{ prompt: "是否重新填写？", reply: "n" }];
    if (!ai) prompts.push({ prompt: "现在配置 AI 能力", reply: "n" });
    prompts.push(systemdPrompt());
    const second = await runInstaller(fixture, prompts);
    expect(second.exitCode, second.output).toBe(0);
    await assertInstalledStartup(fixture, second.output, ai);
    expect(second.output).toContain("Restored state for 1 chat(s).");
    expect(second.output).toContain("INSTALL_API getChat");
    expect(await Bun.file(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json")).text()).toBe(telegram);
  }, 60_000);

  test("存在但非法的可选配置在启动之前拒绝", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    await writeText(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "stickers.json"), "{}\n");
    const result = await runInstaller(fixture, firstInstallPrompts(false));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("stickers.json: $ must be");
    expect(result.output).not.toContain("INSTALL_API");
    expect(result.output).not.toContain("Bot started");
    expect(await Bun.file(join(fixture.runtimeRoot, "state.json")).exists()).toBe(false);
    expect(await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "stickers.json")).text()).toBe("{}\n");
  }, 30_000);
});
