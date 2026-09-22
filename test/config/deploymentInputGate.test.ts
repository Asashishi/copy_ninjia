/**
 * 启动总闸的「存在即校验」路径：每一份可选部署输入都用真实 loader 跑一遍，
 * 确认文件存在但非法时以拒绝启动收场，并覆盖 deploymentInputExists 对
 * 「真正缺省」与「已配置但读不到」的区分。
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { TEST_CONFIG_ROOT, TEST_DATA_ROOT } from "../preloadEnv";
import type { BotConfig } from "../../packages/types/config";

const testRoot: string = mkdtempSync(join(TEST_DATA_ROOT, "copy-ninjia-input-gate-"));
afterAll((): void => { rmSync(testRoot, { recursive: true, force: true }); });

const STICKERS_PATH: string = join(testRoot, "stickers.json");
const MOOD_PATH: string = join(testRoot, "mood.json");
const AD_SAMPLES_PATH: string = join(testRoot, "ad_samples.json");
const AGENT_PATH: string = join(testRoot, "agent.json");
const AUTH_PATH: string = join(testRoot, "g-auth.json");
const PERSONA_FILE_PATH: string = join(testRoot, "persona.md");
const CRON_PATH: string = join(testRoot, "cron.json");

const TEST_PRIVATE_KEY: string = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

mock.module("../../packages/consts/paths", () => ({
  PROJECT_ROOT: testRoot,
  STICKERS_CONFIG_PATH: STICKERS_PATH,
  MOOD_CONFIG_PATH: MOOD_PATH,
  AD_SAMPLES_CONFIG_PATH: AD_SAMPLES_PATH,
  AGENT_CONFIG_PATH: AGENT_PATH,
  GOOGLE_AUTH_FILE_PATH: AUTH_PATH,
  PERSONA_PATH: PERSONA_FILE_PATH,
  CRON_CONFIG_PATH: CRON_PATH,
  BOT_CONFIG_PATH: join(testRoot, "bot.json"),
}));
mock.module("../../packages/config/bot", () => ({
  BOT_ATMOSPHERE: "teasing",
  getBotConfig: (): BotConfig => ({ atmosphere: "mesugaki", botToken: "telegram-token", superAdminUserId: 1 }),
}));

const { deploymentInputExists, validateExistingDeploymentInputs } =
  await import("../../packages/config/readiness");
const {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  translateConfigReadinessCache,
} = await import("../../packages/cache/main/configReadiness");
const {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
  personaCache,
} = await import("../../packages/cache/perThread/config");
const { cronConfigCache } = await import("../../packages/cache/main/cron");
const { googleServiceAccountKey } = await import("../../packages/cache/main/translate");

/** 每个用例都从一份合法部署开始；只有被点名的那一份被改成非法。 */
beforeEach(async (): Promise<void> => {
  for (const name of ["stickers.json", "mood.json", "ad_samples.json", "agent.json", "cron.json"]) {
    await Bun.write(join(testRoot, name), Bun.file(join(TEST_CONFIG_ROOT, name)));
  }
  await Bun.write(PERSONA_FILE_PATH, Bun.file(join(import.meta.dir, "..", "..", "prompt", "persona.md")));
  await Bun.write(AUTH_PATH, JSON.stringify({
    type: "service_account",
    client_email: "bot@example.iam.gserviceaccount.com",
    private_key: TEST_PRIVATE_KEY,
  }));
  adDetectConfigReadinessCache.current = null;
  aiChatConfigReadinessCache.current = null;
  translateConfigReadinessCache.current = null;
  adDetectAgentConfigCache.current = null;
  agentDeploymentConfigCache.current = null;
  defaultAdSampleConfigCache.current = null;
  defaultMoodConfigCache.current = null;
  defaultStickerConfigCache.current = null;
  personaCache.current = null;
  cronConfigCache.current = null;
  googleServiceAccountKey.current = null;
});

test("七份可选部署输入齐备且合法时启动总闸放行", async () => {
  await validateExistingDeploymentInputs();
  expect(defaultMoodConfigCache.current).not.toBeNull();
  expect(defaultStickerConfigCache.current).not.toBeNull();
  expect(defaultAdSampleConfigCache.current).not.toBeNull();
  expect(agentDeploymentConfigCache.current).not.toBeNull();
  expect(personaCache.current).not.toBeNull();
  expect(cronConfigCache.current).not.toBeNull();
  expect(googleServiceAccountKey.current).not.toBeNull();
});

// 每一行都是一条独立的启动闸：删掉 probes 表里的任意一项，对应用例必须变红。
const INVALID_INPUTS: readonly Readonly<{ label: string; path: string; content: string }>[] = [
  { label: "stickers.json", path: STICKERS_PATH, content: JSON.stringify({ packs: "MikuCat4" }) },
  { label: "mood.json", path: MOOD_PATH, content: JSON.stringify({ moods: [] }) },
  { label: "ad_samples.json", path: AD_SAMPLES_PATH, content: JSON.stringify({ samples: [] }) },
  { label: "agent.json", path: AGENT_PATH, content: JSON.stringify({ agent: 7 }) },
  { label: "g-auth.json", path: AUTH_PATH, content: JSON.stringify({ client_email: "", private_key: "" }) },
  { label: "persona.md", path: PERSONA_FILE_PATH, content: "   \n" },
  { label: "cron.json", path: CRON_PATH, content: JSON.stringify({ tasks: [] }) },
];

for (const input of INVALID_INPUTS) {
  test(`${input.label} 存在但非法时启动总闸拒绝并点名该文件`, async () => {
    await Bun.write(input.path, input.content);
    await expect(validateExistingDeploymentInputs()).rejects.toThrow(input.path);
  });
}

test("同一份输入换成目录同样拒绝启动，不按缺省放行", async () => {
  rmSync(MOOD_PATH, { force: true });
  rmSync(join(testRoot, "mood-as-directory"), { recursive: true, force: true });
  await Bun.write(join(testRoot, "mood.json", "inner.json"), "{}");
  await expect(validateExistingDeploymentInputs()).rejects.toThrow(MOOD_PATH);
  rmSync(MOOD_PATH, { recursive: true, force: true });
});

test("断链软链接算作已配置，交给 loader 拒绝，不被当成缺省", async () => {
  rmSync(CRON_PATH, { force: true });
  symlinkSync(join(testRoot, "cron-target-missing.json"), CRON_PATH);
  expect(await deploymentInputExists(CRON_PATH)).toBeTrue();
  await expect(validateExistingDeploymentInputs()).rejects.toThrow(CRON_PATH);
  rmSync(CRON_PATH, { force: true });
});

test("真正缺省的可选文件才按缺省放行", async () => {
  expect(await deploymentInputExists(join(testRoot, "never-written.json"))).toBeFalse();
});

test("探测本身失败（非 ENOENT）按「已配置但读不到」拒绝", async () => {
  const plainFile: string = join(testRoot, "plain-file");
  await Bun.write(plainFile, "x");
  await expect(deploymentInputExists(join(plainFile, "child.json")))
    .rejects.toThrow("an accessible deployment input");
});
