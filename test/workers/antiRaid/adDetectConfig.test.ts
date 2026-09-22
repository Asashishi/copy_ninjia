import { afterEach, describe, expect, test } from "bun:test";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import { adDetectSystemPrompts } from "../../../packages/cache/workers/antiRaid/adDetect";
import { adDetectGoogleClientHolder } from "../../../packages/cache/workers/antiRaid/google";
import { adDetectOpenAiClientHolder } from "../../../packages/cache/workers/antiRaid/openai";
import {
  adDetectAgentConfigCache,
  defaultAdSampleConfigCache,
} from "../../../packages/cache/perThread/config";
import { adoptAdDetectConfigMessage } from "../../../packages/workers/antiRaid/adDetect/config";
import type { AdDetectAgentConfig, AdSampleConfig } from "../../../packages/types/config";

const originalAdDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
const originalSamples: AdSampleConfig | null = defaultAdSampleConfigCache.current;

const reloadedAdDetect: AdDetectAgentConfig = {
  provider: "openai",
  apiKey: "reloaded-ad-key",
  baseUrl: "https://ad.example/v1",
  model: "reloaded-ad-model",
};

/** 装上按旧快照派生的客户端与提示词缓存。 */
function seedDerivedState(): void {
  adDetectGoogleClientHolder.current = {} as GoogleGenAI;
  adDetectOpenAiClientHolder.current = {} as OpenAI;
  adDetectSystemPrompts.set(true, "old prompt");
  adDetectSystemPrompts.set(false, "old prompt");
}

afterEach((): void => {
  adDetectAgentConfigCache.current = originalAdDetect;
  defaultAdSampleConfigCache.current = originalSamples;
  adDetectGoogleClientHolder.current = null;
  adDetectOpenAiClientHolder.current = null;
  adDetectSystemPrompts.clear();
});

describe("Anti-Raid Worker 接管广告检测配置", () => {
  test("新快照整体替换 holder，并丢弃旧客户端与 system prompt 缓存", () => {
    seedDerivedState();
    const samples: AdSampleConfig = ["新的广告示例"];

    adoptAdDetectConfigMessage({ defaultAtmosphere: "teasing", type: "agentConfig", adDetect: reloadedAdDetect, adSamples: samples });

    expect(adDetectAgentConfigCache.current).toBe(reloadedAdDetect);
    expect(defaultAdSampleConfigCache.current).toBe(samples);
    expect(adDetectGoogleClientHolder.current).toBeNull();
    expect(adDetectOpenAiClientHolder.current).toBeNull();
    expect(adDetectSystemPrompts.size).toBe(0);
  });

  test("广告检测不可用时示例 holder 与提示词缓存保持不动，ad_detect 显式写 null", () => {
    seedDerivedState();

    adoptAdDetectConfigMessage({ defaultAtmosphere: "teasing", type: "agentConfig", adDetect: null, adSamples: null });

    expect(adDetectAgentConfigCache.current).toBeNull();
    expect(defaultAdSampleConfigCache.current).toBe(originalSamples);
    expect(adDetectSystemPrompts.size).toBe(2);
    expect(adDetectGoogleClientHolder.current).toBeNull();
    expect(adDetectOpenAiClientHolder.current).toBeNull();
  });
});
