import { beforeEach, describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConfigReadiness,
  TelegramConfig,
} from "../../packages/types/config";

const authFilePath: string = join(mkdtempSync(join(tmpdir(), "copy-ninjia-readiness-")), "g-auth.json");
const personaPath: string = join(tmpdir(), "unused-persona.md");
const testPrivateKey: string = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

let stickerFailure: string | null = null;
let reactionFailure: string | null = null;
let moodFailure: string | null = null;
let adSampleFailure: string | null = null;
let adDetectSectionFailure: string | null = null;
let agentSectionFailure: string | null = null;
let telegramFailure: string | null = null;
/** 每个 loader 的调用次数；readiness 命中缓存后必须不再增长。 */
const loaderCalls = new Map<string, number>();

function countCall(name: string): void {
  loaderCalls.set(name, (loaderCalls.get(name) ?? 0) + 1);
}

function loaderOf(name: string, failure: () => string | null): () => Promise<object> {
  return async (): Promise<object> => {
    countCall(name);
    const message: string | null = failure();
    if (message !== null) throw new Error(message);
    return {};
  };
}

mock.module("../../packages/consts/paths", () => ({
  GOOGLE_AUTH_FILE_PATH: authFilePath,
  TELEGRAM_CONFIG_PATH: join(tmpdir(), "unused-telegram.json"),
  AGENT_CONFIG_PATH: join(tmpdir(), "unused-agent.json"),
  STICKERS_CONFIG_PATH: join(tmpdir(), "unused-stickers.json"),
  REACTIONS_CONFIG_PATH: join(tmpdir(), "unused-reactions.json"),
  MOOD_CONFIG_PATH: join(tmpdir(), "unused-mood.json"),
  AD_SAMPLES_CONFIG_PATH: join(tmpdir(), "unused-ad-samples.json"),
  PERSONA_PATH: personaPath,
}));
mock.module("../../packages/config/telegram", () => ({
  getTelegramConfig: (): TelegramConfig => {
    if (telegramFailure !== null) throw new Error(telegramFailure);
    return { botToken: "telegram-token", superAdminUserId: 1 };
  },
}));
mock.module("../../packages/config/stickers", () => ({
  ensureStickerConfig: loaderOf("stickers", (): string | null => stickerFailure),
}));
mock.module("../../packages/config/reactions", () => ({
  ensureReactionConfig: loaderOf("reactions", (): string | null => reactionFailure),
}));
mock.module("../../packages/config/mood", () => ({
  ensureMoodConfig: loaderOf("mood", (): string | null => moodFailure),
}));
mock.module("../../packages/config/adSamples", () => ({
  ensureAdSampleConfig: loaderOf("adSamples", (): string | null => adSampleFailure),
}));
mock.module("../../packages/config/agent", () => ({
  ensureAdDetectAgentConfig: async (): Promise<void> => {
    countCall("agent.ad_detect");
    if (adDetectSectionFailure !== null) throw new Error(adDetectSectionFailure);
  },
  ensureAgentDeploymentConfig: async (): Promise<void> => {
    countCall("agent");
    if (agentSectionFailure !== null) throw new Error(agentSectionFailure);
  },
  validateAgentDeploymentConfig: async (): Promise<void> => {
    if (agentSectionFailure !== null) throw new Error(agentSectionFailure);
    if (adDetectSectionFailure !== null) throw new Error(adDetectSectionFailure);
  },
}));
mock.module("../../packages/config/persona", () => ({
  ensurePersona: async (): Promise<void> => {
    countCall("persona");
  },
}));

const {
  adDetectConfigReadiness,
  aiChatConfigReadiness,
  jaTranslateConfigReadiness,
  validateExistingDeploymentInputs,
} = await import("../../packages/config/readiness");
const {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  jaTranslateConfigReadinessCache,
} = await import("../../packages/cache/main/configReadiness");

function writeAuthFile(content: string): void {
  writeFileSync(authFilePath, content, "utf8");
}

beforeEach((): void => {
  loaderCalls.clear();
  stickerFailure = null;
  reactionFailure = null;
  moodFailure = null;
  adSampleFailure = null;
  adDetectSectionFailure = null;
  agentSectionFailure = null;
  telegramFailure = null;
  aiChatConfigReadinessCache.current = null;
  adDetectConfigReadinessCache.current = null;
  jaTranslateConfigReadinessCache.current = null;
  writeAuthFile(JSON.stringify({ client_email: "bot@example.iam.gserviceaccount.com", private_key: testPrivateKey }));
});

describe("deployment config readiness", () => {
  test("Telegram 进程级配置缺失时无条件拒绝启动", async () => {
    telegramFailure = "config/telegram.json: $.bot_token must be a non-empty string";
    await expect(validateExistingDeploymentInputs()).rejects.toThrow("config/telegram.json: $.bot_token");
  });

  test("配置齐全时两项 AI 功能分别放行", async () => {
    await validateExistingDeploymentInputs();
    expect(aiChatConfigReadiness()).toEqual({ ok: true });
    expect(adDetectConfigReadiness()).toEqual({ ok: true });
  });

  test("AI 闲聊按声明顺序报第一份坏文件并缓存失败", async () => {
    reactionFailure = "Invalid reactions config: boom";
    moodFailure = "Invalid mood config: also broken";
    await validateExistingDeploymentInputs();
    const verdict: ConfigReadiness = aiChatConfigReadiness();
    if (verdict.ok) throw new Error("expected a failure verdict");
    expect(verdict.failure.file).toBe("config/reactions.json");
    reactionFailure = null;
    expect(aiChatConfigReadiness().ok).toBe(false);
  });

  test("agent 与 ad_detect 分段探测互不污染", async () => {
    agentSectionFailure = "Invalid agent config";
    await validateExistingDeploymentInputs();
    expect(aiChatConfigReadiness().ok).toBe(false);
    expect(adDetectConfigReadiness().ok).toBe(true);

    aiChatConfigReadinessCache.current = null;
    adDetectConfigReadinessCache.current = null;
    agentSectionFailure = null;
    adDetectSectionFailure = "Invalid ad endpoint";
    await validateExistingDeploymentInputs();
    expect(aiChatConfigReadiness().ok).toBe(true);
    const verdict: ConfigReadiness = adDetectConfigReadiness();
    expect(verdict.ok === false && verdict.failure.file).toBe("config/agent.json");
  });

  test("命中缓存后不再调用 loader，且返回同一结论引用", async () => {
    await validateExistingDeploymentInputs();
    const firstAiChat: ConfigReadiness = aiChatConfigReadiness();
    const firstAdDetect: ConfigReadiness = adDetectConfigReadiness();
    const firstJa: ConfigReadiness = jaTranslateConfigReadiness();
    expect(loaderCalls.get("stickers")).toBe(1);
    expect(loaderCalls.get("agent")).toBe(1);
    expect(loaderCalls.get("agent.ad_detect")).toBe(1);

    for (let round: number = 0; round < 3; round++) {
      expect(aiChatConfigReadiness()).toBe(firstAiChat);
      expect(adDetectConfigReadiness()).toBe(firstAdDetect);
      expect(jaTranslateConfigReadiness()).toBe(firstJa);
    }
    // 热路径每条群消息都会问一次；命中缓存的那一路不得重新探测任何一份文件。
    expect(loaderCalls.get("stickers")).toBe(1);
    expect(loaderCalls.get("reactions")).toBe(1);
    expect(loaderCalls.get("mood")).toBe(1);
    expect(loaderCalls.get("persona")).toBe(1);
    expect(loaderCalls.get("agent")).toBe(1);
    expect(loaderCalls.get("adSamples")).toBe(1);
    expect(loaderCalls.get("agent.ad_detect")).toBe(1);
  });

  test("失败结论同样缓存：坏文件在同一进程内只解析一次", async () => {
    moodFailure = "Invalid mood config: boom";
    await validateExistingDeploymentInputs();
    const verdict: ConfigReadiness = aiChatConfigReadiness();
    expect(verdict.ok).toBe(false);
    // 探测在第三份就停下，人设与 agent 段这一轮不该被读到。
    expect(loaderCalls.get("persona")).toBeUndefined();
    expect(loaderCalls.get("agent")).toBeUndefined();

    moodFailure = null;
    expect(aiChatConfigReadiness()).toBe(verdict);
    expect(loaderCalls.get("mood")).toBe(1);
  });
});

describe("Google service account readiness", () => {
  test("启动总闸复用已经通过的密钥校验结论", async () => {
    await validateExistingDeploymentInputs();
    const cached: ConfigReadiness | null = jaTranslateConfigReadinessCache.current;
    if (cached === null) throw new Error("expected startup validation to seed readiness");
    expect(cached).toEqual({ ok: true });
    expect(jaTranslateConfigReadiness()).toBe(cached);
  });

  test("非对象与空字段均拒绝", async () => {
    writeAuthFile(JSON.stringify(["client_email"]));
    await expect(validateExistingDeploymentInputs()).rejects.toThrow("Google service account JSON object");

    jaTranslateConfigReadinessCache.current = null;
    writeAuthFile(JSON.stringify({ client_email: "bot@example.com", private_key: "   " }));
    await expect(validateExistingDeploymentInputs()).rejects.toThrow("private_key");
  });

  test("不可解析私钥不回显原值", async () => {
    const marker: string = "-----BEGIN-LEAK-MARKER-----";
    writeAuthFile(JSON.stringify({ client_email: "bot@example.com", private_key: marker }));
    await expect(validateExistingDeploymentInputs()).rejects.toThrow("$.private_key");
    await expect(validateExistingDeploymentInputs()).rejects.not.toThrow(marker);
  });
});
