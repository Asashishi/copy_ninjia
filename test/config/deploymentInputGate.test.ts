import { getTimeZone } from "../../packages/config/time";
/**
 * 启动总闸的「存在即校验」路径：每一份可选部署输入都用真实 loader 跑一遍，
 * 确认文件存在但非法时以拒绝启动收场，并覆盖 deploymentInputExists 对
 * 「真正缺省」与「已配置但读不到」的区分，以及人设缺省时接管内置人设、send_voice 说明缺省时
 * 保持 null。
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { TEST_CONFIG_ROOT, TEST_DATA_ROOT } from "../preloadEnv";
import { DYNAMIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import { DEFAULT_AI_PERSONA } from "../../packages/consts/aiChat/prompts/persona";
import { BOT_ATMOSPHERES, DEFAULT_BOT_ATMOSPHERE } from "../../packages/consts/bot";
import type { Atmosphere, BotAtmosphere } from "../../packages/types/atmosphere";
import type { BotConfig } from "../../packages/types/config";

const testRoot: string = mkdtempSync(join(TEST_DATA_ROOT, "copy-ninjia-input-gate-"));
afterAll((): void => { rmSync(testRoot, { recursive: true, force: true }); });

const STICKERS_PATH: string = join(testRoot, "stickers.json");
const MOOD_PATH: string = join(testRoot, "mood.json");
const AD_SAMPLES_PATH: string = join(testRoot, "ad_samples.json");
const AGENT_PATH: string = join(testRoot, "agent.json");
const AUTH_PATH: string = join(testRoot, "g-auth.json");
const PERSONA_FILE_PATH: string = join(testRoot, "persona.md");
const VOICE_TOOL_PROMPT_FILE_PATH: string = join(testRoot, "voice_tool.md");
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
  VOICE_TOOL_PROMPT_PATH: VOICE_TOOL_PROMPT_FILE_PATH,
  CRON_CONFIG_PATH: CRON_PATH,
  BOT_CONFIG_PATH: join(testRoot, "bot.json"),
}));
const BOT_CONFIG: BotConfig = { timeZone: getTimeZone(), atmosphere: "mesugaki", botToken: "telegram-token", superAdminUserId: 1 };
const botConfigState: { current: BotConfig } = { current: BOT_CONFIG };
mock.module("../../packages/config/bot", () => ({
  getBotConfig: (): BotConfig => botConfigState.current,
}));
/** 夹具里部署方自定义的人设正文；首尾空白在接管时去掉。 */
const CUSTOM_PERSONA: string = "部署方自定义的温和人设";
/** 夹具里部署方自定义的 send_voice 说明；首尾空白在接管时去掉。 */
const CUSTOM_VOICE_TOOL_PROMPT: string = "部署方自定义的语音工具说明";

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
  voiceToolPromptCache,
} = await import("../../packages/cache/perThread/config");
const { cronConfigCache } = await import("../../packages/cache/main/cron");
const { botAtmosphereState } = await import("../../packages/cache/main/atmosphere");
const PRELOADED_PERSONA: string | null = personaCache.current;
const PRELOADED_VOICE_TOOL_PROMPT: string | null = voiceToolPromptCache.current;
const PRELOADED_ATMOSPHERE: Atmosphere | null = botAtmosphereState.current;
afterAll((): void => {
  personaCache.current = PRELOADED_PERSONA;
  voiceToolPromptCache.current = PRELOADED_VOICE_TOOL_PROMPT;
  botAtmosphereState.current = PRELOADED_ATMOSPHERE;
});
const { googleServiceAccountKey } = await import("../../packages/cache/main/translate");

/** 每个用例都从一份合法部署开始；只有被点名的那一份被改成非法。 */
beforeEach(async (): Promise<void> => {
  botConfigState.current = BOT_CONFIG;
  for (const name of ["stickers.json", "mood.json", "ad_samples.json", "agent.json", "cron.json"]) {
    await Bun.write(join(testRoot, name), Bun.file(join(TEST_CONFIG_ROOT, DYNAMIC_CONFIG_DIR_NAME, name)));
  }
  await Bun.write(PERSONA_FILE_PATH, `\n${CUSTOM_PERSONA}  \n`);
  await Bun.write(VOICE_TOOL_PROMPT_FILE_PATH, `\n${CUSTOM_VOICE_TOOL_PROMPT}  \n`);
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
  voiceToolPromptCache.current = null;
  botAtmosphereState.current = null;
  cronConfigCache.current = null;
  googleServiceAccountKey.current = null;
});

test("八份可选部署输入齐备且合法时启动总闸放行，自定义人设使用显式通知风格", async () => {
  await validateExistingDeploymentInputs();
  expect(defaultMoodConfigCache.current).not.toBeNull();
  expect(defaultStickerConfigCache.current).not.toBeNull();
  expect(defaultAdSampleConfigCache.current).not.toBeNull();
  expect(agentDeploymentConfigCache.current).not.toBeNull();
  expect(personaCache.current).toBe(CUSTOM_PERSONA);
  expect(voiceToolPromptCache.current).toBe(CUSTOM_VOICE_TOOL_PROMPT);
  expect(botAtmosphereState.current).toBe(BOT_ATMOSPHERES[BOT_CONFIG.atmosphere ?? DEFAULT_BOT_ATMOSPHERE]);
  expect(cronConfigCache.current).not.toBeNull();
  expect(googleServiceAccountKey.current).not.toBeNull();
});

test("persona.md 真正缺省时接管内置人设并沿用 Bot 配置语气，AI 可用性不受影响", async () => {
  rmSync(PERSONA_FILE_PATH, { force: true });
  await validateExistingDeploymentInputs();
  expect(personaCache.current).toBe(DEFAULT_AI_PERSONA);
  expect(botAtmosphereState.current).toBe(BOT_ATMOSPHERES[BOT_CONFIG.atmosphere ?? DEFAULT_BOT_ATMOSPHERE]);
  expect(aiChatConfigReadinessCache.current).toEqual({ ok: true });
});

test("voice_tool.md 真正缺省时 send_voice 说明保持 null，人设与 AI 可用性不受影响", async () => {
  voiceToolPromptCache.current = "上一轮遗留的说明";
  rmSync(VOICE_TOOL_PROMPT_FILE_PATH, { force: true });
  await validateExistingDeploymentInputs();
  expect(voiceToolPromptCache.current).toBeNull();
  expect(personaCache.current).toBe(CUSTOM_PERSONA);
  expect(aiChatConfigReadinessCache.current).toEqual({ ok: true });
});

test("没有配置 agent.tts 时已存在的 voice_tool.md 照样严格校验", async () => {
  const agentDocument: { agent: Record<string, unknown> } = await Bun.file(AGENT_PATH).json();
  delete agentDocument.agent.tts;
  await Bun.write(AGENT_PATH, JSON.stringify(agentDocument));
  await Bun.write(VOICE_TOOL_PROMPT_FILE_PATH, " \n\t ");
  await expect(validateExistingDeploymentInputs()).rejects.toThrow(
    `${VOICE_TOOL_PROMPT_FILE_PATH}: $ must be a readable non-empty UTF-8 text file`
  );
});

const ATMOSPHERE_CASES: readonly (readonly [boolean, BotAtmosphere | undefined, Atmosphere])[] = [
  [true, "mesugaki", BOT_ATMOSPHERES.mesugaki],
  [true, "normal", BOT_ATMOSPHERES.normal],
  [true, undefined, BOT_ATMOSPHERES.normal],
  [false, "mesugaki", BOT_ATMOSPHERES.mesugaki],
  [false, "normal", BOT_ATMOSPHERES.normal],
  [false, undefined, BOT_ATMOSPHERES[DEFAULT_BOT_ATMOSPHERE]],
];

test.each(ATMOSPHERE_CASES)(
  "自定义人设 %s、显式风格 %s 时采用 %s，AI 人设独立接管",
  async (hasCustomPersona: boolean, atmosphere: BotAtmosphere | undefined, expected: Atmosphere): Promise<void> => {
    botConfigState.current = { ...BOT_CONFIG, atmosphere };
    if (!hasCustomPersona) await Bun.file(PERSONA_FILE_PATH).delete();
    await validateExistingDeploymentInputs();
    expect(botAtmosphereState.current).toBe(expected);
    expect(personaCache.current).toBe(hasCustomPersona ? CUSTOM_PERSONA : DEFAULT_AI_PERSONA);
  }
);

test("人设与风格已接管时启动总闸只读 holder，不再读盘", async () => {
  personaCache.current = "已经接管的人设";
  botAtmosphereState.current = "teasing";
  await validateExistingDeploymentInputs();
  expect(personaCache.current).toBe("已经接管的人设");
  expect(botAtmosphereState.current).toBe("teasing");
});

// 每一行都是一条独立的启动闸：删掉 probes 表里的任意一项，对应用例必须变红。
const INVALID_INPUTS: readonly Readonly<{ label: string; path: string; content: string }>[] = [
  { label: "stickers.json", path: STICKERS_PATH, content: JSON.stringify({ packs: "MikuCat4" }) },
  { label: "mood.json", path: MOOD_PATH, content: JSON.stringify({ moods: [] }) },
  { label: "ad_samples.json", path: AD_SAMPLES_PATH, content: JSON.stringify({ samples: [] }) },
  { label: "agent.json", path: AGENT_PATH, content: JSON.stringify({ agent: 7 }) },
  { label: "g-auth.json", path: AUTH_PATH, content: JSON.stringify({ client_email: "", private_key: "" }) },
  { label: "persona.md", path: PERSONA_FILE_PATH, content: "   \n" },
  { label: "voice_tool.md", path: VOICE_TOOL_PROMPT_FILE_PATH, content: "   \n" },
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
