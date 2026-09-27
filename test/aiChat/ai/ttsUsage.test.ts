/** AI 与预留额度独立计数，共同过期，恢复与配置变动保持已用次数。 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GEMINI_SPEECH_STYLE } from "../../../packages/consts/aiChat/gemini";
import { TTS_USAGE_WINDOW_MS } from "../../../packages/consts/aiChat/voiceMessage";
import { adoptAgentDeploymentConfig } from "../../../packages/config/agent";
import { ttsQuotaLimit } from "../../../packages/aiChat/ai/utils/ttsUsageWindow";
import type { AgentDeploymentConfig, AgentTtsCapabilityConfig } from "../../../packages/types/config";
import type { TtsDailyUsage, TtsQuotaScope } from "../../../packages/types/aiChat/voiceMessage";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });
const { aiTtsRemaining, claimTtsUsage, hydrateTtsUsage } = await import("../../../packages/aiChat/ai/ttsUsage");
const { ttsDailyUsage } = await import("../../../packages/cache/workers/aiChat/ttsUsage");

const NOW: number = 1_800_000_000_000;
const FULL_LIMIT: number = 100;
const RESERVE_LIMIT: number = 15;
const AI_LIMIT: number = FULL_LIMIT - RESERVE_LIMIT;
const CAPABILITY = { provider: "google", apiKey: "key", baseUrl: undefined, headers: undefined, model: "m" } as const;

function ttsConfig(dailyLimit: number, dailyReserveQuota: number): AgentTtsCapabilityConfig {
  return { ...CAPABILITY, voice: "Leda", style: GEMINI_SPEECH_STYLE, dailyLimit, dailyReserveQuota };
}

function adoptTts(tts: AgentTtsCapabilityConfig | undefined): void {
  const config: AgentDeploymentConfig = { text: CAPABILITY, summary: CAPABILITY, media: CAPABILITY, tts };
  adoptAgentDeploymentConfig(config);
}

beforeEach(() => {
  postMessage.mockClear();
  ttsDailyUsage.current = null;
  adoptTts(ttsConfig(FULL_LIMIT, RESERVE_LIMIT));
});

afterAll(() => {
  adoptAgentDeploymentConfig(null);
  if (originalSelfDescriptor === undefined) Reflect.deleteProperty(globalThis, "self");
  else Object.defineProperty(globalThis, "self", originalSelfDescriptor);
});

describe("claimTtsUsage", () => {
  test.each(["ai", "operator"] as const)("%s 先使用时，另一入口首次使用保留原窗口与计数", (first: TtsQuotaScope) => {
    const second: TtsQuotaScope = first === "ai" ? "operator" : "ai";
    const tts: AgentTtsCapabilityConfig = ttsConfig(FULL_LIMIT, RESERVE_LIMIT);
    expect(claimTtsUsage(first, ttsQuotaLimit(tts, first), NOW)).toBeTrue();
    const initial: TtsDailyUsage | null = ttsDailyUsage.current;
    expect(initial).toEqual({ windowStartedAt: NOW, agentCount: first === "ai" ? 1 : 0, reserveCount: first === "operator" ? 1 : 0 });
    expect(claimTtsUsage(second, ttsQuotaLimit(tts, second), NOW + 5_000)).toBeTrue();
    expect(ttsDailyUsage.current).toEqual({ windowStartedAt: NOW, agentCount: 1, reserveCount: 1 });
    expect(initial).not.toBe(ttsDailyUsage.current);
    expect(postMessage.mock.calls).toEqual([
      [{ type: "ttsUsage", usage: initial }],
      [{ type: "ttsUsage", usage: { windowStartedAt: NOW, agentCount: 1, reserveCount: 1 } }],
    ]);
  });

  test.each(["ai", "operator"] as const)("%s 先用满，另一入口仍可用满自己的额度", (first: TtsQuotaScope) => {
    const scopes: readonly TtsQuotaScope[] = [first, first === "ai" ? "operator" : "ai"];
    const tts: AgentTtsCapabilityConfig = ttsConfig(FULL_LIMIT, RESERVE_LIMIT);
    for (const scope of scopes) {
      const limit: number = ttsQuotaLimit(tts, scope);
      for (let index: number = 0; index < limit; index++) expect(claimTtsUsage(scope, limit, NOW + index)).toBeTrue();
      const before: TtsDailyUsage | null = ttsDailyUsage.current;
      const events: number = postMessage.mock.calls.length;
      expect(claimTtsUsage(scope, limit, NOW + FULL_LIMIT)).toBeFalse();
      expect(ttsDailyUsage.current).toBe(before);
      expect(postMessage).toHaveBeenCalledTimes(events);
    }
    expect(ttsDailyUsage.current).toEqual({ windowStartedAt: NOW, agentCount: AI_LIMIT, reserveCount: RESERVE_LIMIT });
    expect(postMessage).toHaveBeenCalledTimes(FULL_LIMIT);
  });

  test.each(["ai", "operator"] as const)("满 24 小时后由 %s 开新窗口，两边同时重置", (scope: TtsQuotaScope) => {
    hydrateTtsUsage({ windowStartedAt: NOW, agentCount: AI_LIMIT, reserveCount: RESERVE_LIMIT });
    const limit: number = scope === "ai" ? AI_LIMIT : RESERVE_LIMIT;
    expect(claimTtsUsage(scope, limit, NOW + TTS_USAGE_WINDOW_MS - 1)).toBeFalse();
    expect(aiTtsRemaining(NOW + TTS_USAGE_WINDOW_MS)).toBe(AI_LIMIT);
    expect(claimTtsUsage(scope, limit, NOW + TTS_USAGE_WINDOW_MS)).toBeTrue();
    expect(ttsDailyUsage.current).toEqual({
      windowStartedAt: NOW + TTS_USAGE_WINDOW_MS,
      agentCount: scope === "ai" ? 1 : 0,
      reserveCount: scope === "operator" ? 1 : 0,
    });
  });

  test("预留为零时拒绝 operator，不占 AI 次数、不创建窗口或回执", () => {
    adoptTts(ttsConfig(FULL_LIMIT, 0));
    expect(claimTtsUsage("operator", 0, NOW)).toBeFalse();
    expect(ttsDailyUsage.current).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
    expect(aiTtsRemaining(NOW)).toBe(FULL_LIMIT);
  });

  test("恢复后的两项计数继续累加，配置调低只阻止对应入口", () => {
    hydrateTtsUsage({ windowStartedAt: NOW, agentCount: 7, reserveCount: 3 });
    expect(claimTtsUsage("ai", 8, NOW + 1)).toBeTrue();
    expect(claimTtsUsage("operator", 2, NOW + 1)).toBeFalse();
    expect(ttsDailyUsage.current).toEqual({ windowStartedAt: NOW, agentCount: 8, reserveCount: 3 });
  });
});

describe("ttsQuotaLimit", () => {
  test("两份独立额度加起来等于 dailyLimit，预留允许为零", () => {
    for (const reserve of [0, RESERVE_LIMIT, FULL_LIMIT - 1]) {
      const tts: AgentTtsCapabilityConfig = ttsConfig(FULL_LIMIT, reserve);
      expect(ttsQuotaLimit(tts, "operator")).toBe(reserve);
      expect(ttsQuotaLimit(tts, "ai")).toBe(FULL_LIMIT - reserve);
    }
  });
});

describe("aiTtsRemaining", () => {
  test("只扣 agentCount，过期时恢复全额但读取不改状态", () => {
    expect(aiTtsRemaining(NOW)).toBe(AI_LIMIT);
    const usage: TtsDailyUsage = { windowStartedAt: NOW, agentCount: 10, reserveCount: RESERVE_LIMIT };
    hydrateTtsUsage(usage);
    expect(aiTtsRemaining(NOW + 1)).toBe(AI_LIMIT - 10);
    expect(aiTtsRemaining(NOW + TTS_USAGE_WINDOW_MS)).toBe(AI_LIMIT);
    expect(ttsDailyUsage.current).toBe(usage);
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("跟随配置变更，不清零；tts 缺省时为零", () => {
    hydrateTtsUsage({ windowStartedAt: NOW, agentCount: 10, reserveCount: 4 });
    adoptTts(ttsConfig(30, 5));
    expect(aiTtsRemaining(NOW + 1)).toBe(15);
    adoptTts(ttsConfig(8, 0));
    expect(aiTtsRemaining(NOW + 1)).toBe(0);
    adoptTts(undefined);
    expect(aiTtsRemaining(NOW + 1)).toBe(0);
  });
});
