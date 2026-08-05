/**
 * 按功能聚合的部署配置可用性判定。这些结论替代了原来在 ApplicationLifecycle
 * 里统一预热的那四次调用：坏掉的文件只能关掉自己那个功能，不能拦住启动。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigReadiness } from "../../packages/types/config";

const authFilePath: string = join(mkdtempSync(join(tmpdir(), "copy-ninjia-readiness-")), "g-auth.json");

let stickerFailure: string | null = null;
let reactionFailure: string | null = null;
let moodFailure: string | null = null;
let adSampleFailure: string | null = null;
// config/openai.json 分两段探测：一段写坏不该拖垮读另一段的那条线。
let adDetectSectionFailure: string | null = null;
let aiChatSectionFailure: string | null = null;
// config/gemini.json 是与 openai.json 平级的第二份模型配置，各自条件探测。
let geminiConfigFailure: string | null = null;
let openAiCredentials: boolean = true;
let geminiCredentials: boolean = true;

function loaderOf(failure: () => string | null): () => object {
  return (): object => {
    const message: string | null = failure();
    if (message !== null) throw new Error(message);
    return {};
  };
}

mock.module("../../packages/consts/paths", () => ({
  GOOGLE_AUTH_FILE_PATH: authFilePath,
  GEMINI_CONFIG_PATH: join(tmpdir(), "unused-gemini.json"),
  OPENAI_CONFIG_PATH: join(tmpdir(), "unused-openai.json"),
}));
mock.module("../../packages/config/stickers", () => ({ getStickerConfig: loaderOf((): string | null => stickerFailure) }));
mock.module("../../packages/config/reactions", () => ({ getReactionConfig: loaderOf((): string | null => reactionFailure) }));
mock.module("../../packages/config/mood", () => ({ getMoodConfig: loaderOf((): string | null => moodFailure) }));
mock.module("../../packages/config/adSamples", () => ({ getAdSampleConfig: loaderOf((): string | null => adSampleFailure) }));
mock.module("../../packages/config/openai", () => ({
  loadAdDetectOpenAiConfig: loaderOf((): string | null => adDetectSectionFailure),
  loadAiAgentOpenAiConfig: loaderOf((): string | null => aiChatSectionFailure),
}));
mock.module("../../packages/config/gemini", () => ({
  loadGeminiDeploymentConfig: loaderOf((): string | null => geminiConfigFailure),
}));
mock.module("../../packages/aiChat/credentials", () => ({
  hasOpenAiChatCredentials: (): boolean => openAiCredentials,
  hasGeminiChatCredentials: (): boolean => geminiCredentials,
}));

const { adDetectConfigReadiness, aiChatConfigReadiness, jaTranslateConfigReadiness } =
  await import("../../packages/config/readiness");
const {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  jaTranslateConfigReadinessCache,
} = await import("../../packages/cache/main/configReadiness");

function writeAuthFile(content: string): void {
  writeFileSync(authFilePath, content, "utf8");
}

beforeEach(() => {
  stickerFailure = null;
  reactionFailure = null;
  moodFailure = null;
  adSampleFailure = null;
  geminiConfigFailure = null;
  geminiCredentials = true;
  adDetectSectionFailure = null;
  aiChatSectionFailure = null;
  openAiCredentials = true;
  aiChatConfigReadinessCache.current = null;
  adDetectConfigReadinessCache.current = null;
  jaTranslateConfigReadinessCache.current = null;
  writeAuthFile(JSON.stringify({ client_email: "bot@example.iam.gserviceaccount.com", private_key: "-----BEGIN-----" }));
});

describe("deployment config readiness", () => {
  test("三份都读得动时 AI 闲聊放行；广告示例独立成一份结论", () => {
    expect(aiChatConfigReadiness()).toEqual({ ok: true });
    expect(adDetectConfigReadiness()).toEqual({ ok: true });
  });

  test("AI 闲聊按声明顺序报第一份坏掉的文件，诊断带上解析器原话", () => {
    reactionFailure = "Invalid reactions config: boom";
    moodFailure = "Invalid mood config: also broken";

    const verdict: ConfigReadiness = aiChatConfigReadiness();
    if (verdict.ok) throw new Error("expected a failure verdict");
    // 一次只点名一份：三份一起报，运维照着改完第一份还是开不起来，
    // 反而看不出到底轮到哪一份了。
    expect(verdict.failure.file).toBe("config/reactions.json");
    expect(verdict.failure.reason).toBe("Invalid reactions config: boom");
  });

  test("某个功能的配置坏掉不影响另一个功能的结论", () => {
    adSampleFailure = "Invalid ad samples config: boom";

    expect(aiChatConfigReadiness()).toEqual({ ok: true });
    expect(adDetectConfigReadiness().ok).toBe(false);
  });

  test("失败结论也进缓存：门禁挂在每条群消息上，不能每次重新读盘", () => {
    stickerFailure = "Invalid stickers config: boom";
    expect(aiChatConfigReadiness().ok).toBe(false);

    // 文件修好了也要重启才生效，与底层 loader 的单例缓存同一口径（拒绝文案
    // 里点明了「修好再重启」）。
    stickerFailure = null;
    expect(aiChatConfigReadiness().ok).toBe(false);
  });

  test("服务账号密钥：缺文件、非对象、字段空缺都算不可用", () => {
    writeAuthFile("{ not json");
    expect(jaTranslateConfigReadiness().ok).toBe(false);

    jaTranslateConfigReadinessCache.current = null;
    writeAuthFile(JSON.stringify(["client_email"]));
    const notObject: ConfigReadiness = jaTranslateConfigReadiness();
    if (notObject.ok) throw new Error("expected a failure verdict");
    expect(notObject.failure.file).toBe("g-auth.json");
    expect(notObject.failure.reason).toContain("expected a JSON object");

    // 只判「文件在不在」不够：占位内容同样能通过，然后每条 /ja_copy 都静默
    // 退化成原文照发，群里看不出与「翻译服务抖了一下」的区别。
    jaTranslateConfigReadinessCache.current = null;
    writeAuthFile(JSON.stringify({ client_email: "bot@example.com", private_key: "   " }));
    const blankKey: ConfigReadiness = jaTranslateConfigReadiness();
    if (blankKey.ok) throw new Error("expected a failure verdict");
    expect(blankKey.failure.reason).toContain("private_key");
  });
});

describe("config/openai.json 分段探测：一段写坏只关掉读那一段的功能", () => {
  test("广告检测把 ad_detect 段当必检项：写坏就点名这份文件", () => {
    adDetectSectionFailure = "bad endpoint";
    const verdict: ConfigReadiness = adDetectConfigReadiness();
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.failure.file).toBe("config/openai.json");
  });

  test("ai_agent 段写坏不拦广告检测：那半边它一个字段都不读", () => {
    // 拦住了就意味着 Gemini 部署为了准备 OpenAI 兜底而写错一个键，
    // 代价是启动 preflight 中止、bot 起不来。
    aiChatSectionFailure = "ai_agent must be an object with only { base_url?, models? }";
    expect(adDetectConfigReadiness().ok).toBe(true);
  });

  test("握有 OpenAI 凭据时 AI 闲聊探 ai_agent 段：坏文件必须在闸门上点名", () => {
    aiChatSectionFailure = "ai_agent must be an object with only { base_url?, models? }";
    const verdict: ConfigReadiness = aiChatConfigReadiness();
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.failure.file).toBe("config/openai.json");
  });

  test("ad_detect 段写坏不拦 AI 闲聊：那半边只服务广告检测", () => {
    adDetectSectionFailure = "bad endpoint";
    expect(aiChatConfigReadiness().ok).toBe(true);
  });

  test("没有 OpenAI 凭据时 AI 闲聊不探它：那份文件在 Gemini 单跑的部署里没有消费方", () => {
    openAiCredentials = false;
    aiChatSectionFailure = "ai_agent must be an object with only { base_url?, models? }";
    expect(aiChatConfigReadiness().ok).toBe(true);
  });
});

describe("Gemini 模型配置：与 openai.json 平级的条件探测", () => {
  test("握着 Gemini 凭据时 config/gemini.json 写坏即判不可用并点名文件", () => {
    // 代码里不再有任何 Gemini 模型默认值，缺文件/缺字段只能拒绝。
    geminiConfigFailure = "Invalid Gemini config: models.reply must be a non-empty string";
    const verdict: ConfigReadiness = aiChatConfigReadiness();
    expect(verdict.ok).toBeFalse();
    if (verdict.ok) throw new Error("expected a failure verdict");
    expect(verdict.failure.file).toBe("config/gemini.json");
  });

  test("没有 Gemini 凭据时根本不探它：只配 OpenAI 一把 key 的部署不被它拦住", () => {
    geminiCredentials = false;
    geminiConfigFailure = "Invalid Gemini config: boom";
    expect(aiChatConfigReadiness().ok).toBeTrue();
  });

  test("反过来也成立：没有 OpenAI 凭据时 openai.json 的 ai_agent 段坏了也不拦 Gemini 部署", () => {
    openAiCredentials = false;
    aiChatSectionFailure = "Invalid OpenAI config: boom";
    expect(aiChatConfigReadiness().ok).toBeTrue();
  });
});
