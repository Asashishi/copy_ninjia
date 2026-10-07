import { getTimeZone } from "../../packages/config/time";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TEST_DATA_ROOT } from "../preloadEnv";
import type {
  ConfigReadiness,
  BotConfig,
} from "../../packages/types/config";

const testRoot: string = mkdtempSync(join(TEST_DATA_ROOT, "copy-ninjia-readiness-"));
const authFilePath: string = join(testRoot, "g-auth.json");
afterAll((): void => { rmSync(testRoot, { recursive: true, force: true }); });
const personaPath: string = join(testRoot, "unused-persona.md");
const voiceToolPromptPath: string = join(testRoot, "unused-voice-tool.md");
const testPrivateKey: string = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

let telegramFailure: string | null = null;

/** 这些路径在测试根下不存在，启动总闸跳过它们的严格解析；占位 loader 只为满足模块导入。 */
async function unusedLoader(): Promise<void> {}

mock.module("../../packages/consts/paths", () => ({
  GOOGLE_AUTH_FILE_PATH: authFilePath,
  BOT_CONFIG_PATH: join(testRoot, "unused-bot.json"),
  AGENT_CONFIG_PATH: join(testRoot, "unused-agent.json"),
  STICKERS_CONFIG_PATH: join(testRoot, "unused-stickers.json"),
  MOOD_CONFIG_PATH: join(testRoot, "unused-mood.json"),
  AD_SAMPLES_CONFIG_PATH: join(testRoot, "unused-ad-samples.json"),
  PERSONA_PATH: personaPath,
  VOICE_TOOL_PROMPT_PATH: voiceToolPromptPath,
}));
mock.module("../../packages/config/bot", () => ({
  getBotConfig: (): BotConfig => {
    if (telegramFailure !== null) throw new Error(telegramFailure);
    return { timeZone: getTimeZone(), atmosphere: "mesugaki", botToken: "telegram-token", superAdminUserId: 1 };
  },
}));
mock.module("../../packages/config/stickers", () => ({ ensureStickerConfig: unusedLoader }));
mock.module("../../packages/config/mood", () => ({ ensureMoodConfig: unusedLoader }));
mock.module("../../packages/config/adSamples", () => ({ ensureAdSampleConfig: unusedLoader }));
mock.module("../../packages/config/agent", () => ({ validateAgentDeploymentConfig: unusedLoader }));
mock.module("../../packages/config/persona", () => ({
  adoptPersona: (): void => {},
}));

const {
  adDetectConfigReadiness,
  aiChatConfigReadiness,
  translateConfigReadiness,
  validateExistingDeploymentInputs,
} = await import("../../packages/config/readiness");
const {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  translateConfigReadinessCache,
} = await import("../../packages/cache/main/configReadiness");
const { googleServiceAccountKey } = await import("../../packages/cache/main/translate");
const {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
} = await import("../../packages/cache/perThread/config");

/** preload 接管的配置 holder 原值；用例把某一份置空表示该文件或该段缺省，之后还原。 */
const HOLDERS = {
  sticker: defaultStickerConfigCache.current,
  mood: defaultMoodConfigCache.current,
  adSample: defaultAdSampleConfigCache.current,
  agent: agentDeploymentConfigCache.current,
  adDetect: adDetectAgentConfigCache.current,
};

function restoreHolders(): void {
  defaultStickerConfigCache.current = HOLDERS.sticker;
  defaultMoodConfigCache.current = HOLDERS.mood;
  defaultAdSampleConfigCache.current = HOLDERS.adSample;
  agentDeploymentConfigCache.current = HOLDERS.agent;
  adDetectAgentConfigCache.current = HOLDERS.adDetect;
}

afterAll(restoreHolders);

async function writeAuthFile(content: string): Promise<void> {
  await Bun.write(authFilePath, content);
}

beforeEach(async (): Promise<void> => {
  restoreHolders();
  telegramFailure = null;
  aiChatConfigReadinessCache.current = null;
  adDetectConfigReadinessCache.current = null;
  translateConfigReadinessCache.current = null;
  googleServiceAccountKey.current = null;
  await writeAuthFile(JSON.stringify({ client_email: "bot@example.iam.gserviceaccount.com", private_key: testPrivateKey }));
});

describe("deployment config readiness", () => {
  test("Telegram 进程级配置缺失时无条件拒绝启动", async () => {
    telegramFailure = "config/static/bot.json: $.bot_token must be a non-empty string";
    await expect(validateExistingDeploymentInputs()).rejects.toThrow("config/static/bot.json: $.bot_token");
  });

  test("启动总闸完成前三项功能都报 startup 未完成", () => {
    for (const readiness of [aiChatConfigReadiness(), adDetectConfigReadiness(), translateConfigReadiness()]) {
      expect(readiness).toEqual({
        ok: false,
        failure: { file: "startup", reason: "deployment configuration preflight has not completed" },
      });
    }
  });

  test("配置齐全时两项 AI 功能分别放行", async () => {
    await validateExistingDeploymentInputs();
    expect(aiChatConfigReadiness()).toEqual({ ok: true });
    expect(adDetectConfigReadiness()).toEqual({ ok: true });
  });

  test("AI 闲聊按声明顺序报第一份缺省的文件并缓存失败", async () => {
    defaultStickerConfigCache.current = null;
    defaultMoodConfigCache.current = null;
    await validateExistingDeploymentInputs();
    const verdict: ConfigReadiness = aiChatConfigReadiness();
    if (verdict.ok) throw new Error("expected a failure verdict");
    expect(verdict.failure.file).toBe("config/dynamic/stickers.json");
    restoreHolders();
    expect(aiChatConfigReadiness()).toBe(verdict);
  });

  test("agent 对话段与 ad_detect 段互不影响", async () => {
    agentDeploymentConfigCache.current = null;
    await validateExistingDeploymentInputs();
    expect(aiChatConfigReadiness().ok).toBe(false);
    expect(adDetectConfigReadiness().ok).toBe(true);

    aiChatConfigReadinessCache.current = null;
    adDetectConfigReadinessCache.current = null;
    restoreHolders();
    adDetectAgentConfigCache.current = null;
    await validateExistingDeploymentInputs();
    expect(aiChatConfigReadiness().ok).toBe(true);
    const verdict: ConfigReadiness = adDetectConfigReadiness();
    expect(verdict.ok === false && verdict.failure.file).toBe("config/dynamic/agent.json");
  });

  test("广告检测的示例清单缺省时报 ad_samples.json", async () => {
    defaultAdSampleConfigCache.current = null;
    await validateExistingDeploymentInputs();
    const verdict: ConfigReadiness = adDetectConfigReadiness();
    expect(verdict.ok === false && verdict.failure.file).toBe("config/dynamic/ad_samples.json");
  });

  test("命中缓存后返回同一结论引用，holder 之后变化也不重算", async () => {
    await validateExistingDeploymentInputs();
    const firstAiChat: ConfigReadiness = aiChatConfigReadiness();
    const firstAdDetect: ConfigReadiness = adDetectConfigReadiness();
    const firstJa: ConfigReadiness = translateConfigReadiness();
    defaultMoodConfigCache.current = null;
    adDetectAgentConfigCache.current = null;
    for (let round: number = 0; round < 3; round++) {
      expect(aiChatConfigReadiness()).toBe(firstAiChat);
      expect(adDetectConfigReadiness()).toBe(firstAdDetect);
      expect(translateConfigReadiness()).toBe(firstJa);
    }
  });
});

describe("Google service account readiness", () => {
  test("预检发布一次快照，改写或删除文件均不影响运行期读取", async () => {
    await validateExistingDeploymentInputs();
    const snapshot = googleServiceAccountKey.current;
    expect(snapshot?.private_key).toBe(testPrivateKey);
    await writeAuthFile("invalid");
    expect(translateConfigReadiness()).toEqual({ ok: true });
    expect(googleServiceAccountKey.current).toBe(snapshot);
    await Bun.file(authFilePath).delete();
    expect(translateConfigReadiness()).toEqual({ ok: true });
    expect(googleServiceAccountKey.current).toBe(snapshot);
  });

  test("缺省时发布不可用结论，进程内补文件和重复 preflight 都不启用翻译", async () => {
    await Bun.file(authFilePath).delete();
    await validateExistingDeploymentInputs();
    const result = translateConfigReadiness();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.file).toBe("config/static/g-auth.json");
    expect(googleServiceAccountKey.current).toBeNull();
    await writeAuthFile(JSON.stringify({ client_email: "bot@example.com", private_key: testPrivateKey }));
    await validateExistingDeploymentInputs();
    expect(translateConfigReadiness()).toBe(result);
    expect(googleServiceAccountKey.current).toBeNull();
  });

  test("启动总闸复用已经通过的密钥校验结论", async () => {
    await validateExistingDeploymentInputs();
    const cached: ConfigReadiness | null = translateConfigReadinessCache.current;
    if (cached === null) throw new Error("expected startup validation to seed readiness");
    expect(cached).toEqual({ ok: true });
    expect(translateConfigReadiness()).toBe(cached);
  });

  test("非对象与空字段均拒绝", async () => {
    await writeAuthFile(JSON.stringify(["client_email"]));
    await expect(validateExistingDeploymentInputs()).rejects.toThrow("Google service account JSON object");

    translateConfigReadinessCache.current = null;
    await writeAuthFile(JSON.stringify({ client_email: "bot@example.com", private_key: "   " }));
    await expect(validateExistingDeploymentInputs()).rejects.toThrow("private_key");
  });

  test("不可解析私钥不回显原值", async () => {
    const marker: string = "-----BEGIN-LEAK-MARKER-----";
    await writeAuthFile(JSON.stringify({ client_email: "bot@example.com", private_key: marker }));
    await expect(validateExistingDeploymentInputs()).rejects.toThrow("$.private_key");
    await expect(validateExistingDeploymentInputs()).rejects.not.toThrow(marker);
  });
});

for (const type of ["authorized_user", "external_account", null, 7]) {
  test("显式错误凭据类型在启动总闸拒绝且不改写原文件", async () => {
    const content: string = JSON.stringify({ type, client_email: "bot@example.com", private_key: testPrivateKey });
    await writeAuthFile(content);
    await expect(validateExistingDeploymentInputs()).rejects.toThrow(authFilePath + ': $.type must be "service_account".');
    expect(await Bun.file(authFilePath).text()).toBe(content);
    expect(translateConfigReadinessCache.current).toBeNull();
  });
}

test("显式 service_account 与缺省 type 均保持可用", async () => {
  await writeAuthFile(JSON.stringify({ type: "service_account", client_email: "bot@example.com", private_key: testPrivateKey }));
  await validateExistingDeploymentInputs();
  expect(translateConfigReadiness()).toEqual({ ok: true });
});
