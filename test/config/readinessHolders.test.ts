import { afterEach, describe, expect, test } from "bun:test";
import type { ConfigReadiness } from "../../packages/types/config";

/**
 * 热重载侧的功能可用性判定：只读主线程 holder，按探测表顺序报第一份缺失文件。
 * holder 只需「空 / 非空」两态，这里用占位对象填充，不解析任何部署文件。
 */

const {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
  personaCache,
} = await import("../../packages/cache/perThread/config");
const {
  adDetectReadinessFromHolders,
  aiChatReadinessFromHolders,
} = await import("../../packages/config/readiness");

/** 只看 holder 是否为空的判定用占位值；类型经 never 放行。 */
const PRESENT: never = {} as never;

function fillAll(): void {
  defaultStickerConfigCache.current = PRESENT;
  defaultMoodConfigCache.current = PRESENT;
  personaCache.current = "人设";
  agentDeploymentConfigCache.current = PRESENT;
  defaultAdSampleConfigCache.current = PRESENT;
  adDetectAgentConfigCache.current = PRESENT;
}

function failedFile(readiness: ConfigReadiness): string | undefined {
  return readiness.ok ? undefined : readiness.failure.file;
}

afterEach(() => {
  defaultStickerConfigCache.current = null;
  defaultMoodConfigCache.current = null;
  personaCache.current = null;
  agentDeploymentConfigCache.current = null;
  defaultAdSampleConfigCache.current = null;
  adDetectAgentConfigCache.current = null;
});

describe("按 holder 重算功能可用性", () => {
  test("AI 闲聊按 stickers → mood → persona → agent 的顺序报第一份缺失", () => {
    fillAll();
    expect(aiChatReadinessFromHolders()).toEqual({ ok: true });

    agentDeploymentConfigCache.current = null;
    expect(failedFile(aiChatReadinessFromHolders())).toBe("config/dynamic/agent.json");
    personaCache.current = null;
    expect(failedFile(aiChatReadinessFromHolders())).toBe("prompt/persona.md");
    defaultMoodConfigCache.current = null;
    expect(failedFile(aiChatReadinessFromHolders())).toBe("config/dynamic/mood.json");
    defaultStickerConfigCache.current = null;
    const readiness: ConfigReadiness = aiChatReadinessFromHolders();
    expect(failedFile(readiness)).toBe("config/dynamic/stickers.json");
    expect(readiness.ok ? "" : readiness.failure.reason).toContain("$ must be a readable valid JSON document");
  });

  test("agent.json 缺对话核心能力段时报字段路径，不回落到其它文件", () => {
    fillAll();
    agentDeploymentConfigCache.current = null;
    const readiness: ConfigReadiness = aiChatReadinessFromHolders();
    expect(readiness.ok ? "" : readiness.failure.reason).toContain("$.agent must be configured with text, summary and media");
  });

  test("广告检测按 ad_samples → agent.ad_detect 的顺序报缺失，与 AI 闲聊互不牵连", () => {
    fillAll();
    expect(adDetectReadinessFromHolders()).toEqual({ ok: true });

    personaCache.current = null;
    expect(adDetectReadinessFromHolders()).toEqual({ ok: true });

    adDetectAgentConfigCache.current = null;
    const readiness: ConfigReadiness = adDetectReadinessFromHolders();
    expect(failedFile(readiness)).toBe("config/dynamic/agent.json");
    expect(readiness.ok ? "" : readiness.failure.reason).toContain("$.agent.ad_detect must be configured");
    defaultAdSampleConfigCache.current = null;
    expect(failedFile(adDetectReadinessFromHolders())).toBe("config/dynamic/ad_samples.json");
  });
});
