import { GEMINI_SPEECH_STYLE } from "../../../packages/consts/aiChat/gemini";
/**
 * 语音合成每日计数（aiChat/ai/ttsUsage.ts）：按调用方上限登记、窗口满一天后以本次
 * 请求为新起点重计、每次登记回传全量计数，额度口径按 `agent.tts` 的 dailyLimit 与
 * dailyReserveQuota 计算，以及模型可见余量按 `ai` 口径计算。
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { TTS_USAGE_WINDOW_MS } from "../../../packages/consts/aiChat/voiceMessage";
import { adoptAgentDeploymentConfig } from "../../../packages/config/agent";
import { ttsQuotaLimit } from "../../../packages/aiChat/ai/utils/ttsUsageWindow";
import type { AgentDeploymentConfig, AgentTtsCapabilityConfig } from "../../../packages/types/config";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });

const { aiTtsRemaining, claimTtsUsage, hydrateTtsUsage } = await import("../../../packages/aiChat/ai/ttsUsage");
const { ttsDailyUsage } = await import("../../../packages/cache/workers/aiChat/ttsUsage");

const NOW: number = 1_800_000_000_000;
const FULL_LIMIT: number = 100;
const AI_LIMIT: number = 75;
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
  adoptTts(ttsConfig(FULL_LIMIT, FULL_LIMIT - AI_LIMIT));
});

afterAll(() => {
  adoptAgentDeploymentConfig(null);
  if (originalSelfDescriptor === undefined) Reflect.deleteProperty(globalThis, "self");
  else Object.defineProperty(globalThis, "self", originalSelfDescriptor);
});

describe("claimTtsUsage", () => {
  test("从没用过时以本次请求为窗口起点，之后在同一窗口内累加并逐次回传", () => {
    expect(claimTtsUsage(FULL_LIMIT, NOW)).toBeTrue();
    expect(ttsDailyUsage.current).toEqual({ windowStartedAt: NOW, count: 1 });
    expect(claimTtsUsage(FULL_LIMIT, NOW + 5_000)).toBeTrue();
    expect(ttsDailyUsage.current).toEqual({ windowStartedAt: NOW, count: 2 });
    expect(postMessage.mock.calls).toEqual([
      [{ type: "ttsUsage", usage: { windowStartedAt: NOW, count: 1 } }],
      [{ type: "ttsUsage", usage: { windowStartedAt: NOW, count: 2 } }],
    ]);
  });

  test("达到调用方上限时拒绝且不改计数、不回传", () => {
    hydrateTtsUsage({ windowStartedAt: NOW, count: AI_LIMIT });
    expect(claimTtsUsage(AI_LIMIT, NOW + 1)).toBeFalse();
    expect(ttsDailyUsage.current).toEqual({ windowStartedAt: NOW, count: AI_LIMIT });
    expect(postMessage).not.toHaveBeenCalled();
    // 完整上限的调用方还能继续用预留的次数。
    expect(claimTtsUsage(FULL_LIMIT, NOW + 1)).toBeTrue();
    hydrateTtsUsage({ windowStartedAt: NOW, count: FULL_LIMIT });
    expect(claimTtsUsage(FULL_LIMIT, NOW + 1)).toBeFalse();
  });

  test("距窗口起点满一天后以本次请求为新起点从 1 计", () => {
    hydrateTtsUsage({ windowStartedAt: NOW, count: FULL_LIMIT });
    expect(claimTtsUsage(FULL_LIMIT, NOW + TTS_USAGE_WINDOW_MS - 1)).toBeFalse();
    expect(claimTtsUsage(FULL_LIMIT, NOW + TTS_USAGE_WINDOW_MS)).toBeTrue();
    expect(ttsDailyUsage.current).toEqual({ windowStartedAt: NOW + TTS_USAGE_WINDOW_MS, count: 1 });
  });
});

describe("ttsQuotaLimit", () => {
  test("operator 口径是 dailyLimit，ai 口径扣掉 dailyReserveQuota", () => {
    expect(ttsQuotaLimit(ttsConfig(100, 25), "operator")).toBe(100);
    expect(ttsQuotaLimit(ttsConfig(100, 25), "ai")).toBe(75);
    expect(ttsQuotaLimit(ttsConfig(10, 0), "ai")).toBe(10);
    expect(ttsQuotaLimit(ttsConfig(10, 9), "ai")).toBe(1);
  });
});

describe("aiTtsRemaining", () => {
  test("按 AI 口径扣掉预留量，不小于 0，过期窗口按从没用过", () => {
    expect(aiTtsRemaining(NOW)).toBe(AI_LIMIT);
    hydrateTtsUsage({ windowStartedAt: NOW, count: 10 });
    expect(aiTtsRemaining(NOW + 1)).toBe(AI_LIMIT - 10);
    hydrateTtsUsage({ windowStartedAt: NOW, count: 90 });
    expect(aiTtsRemaining(NOW + 1)).toBe(0);
    expect(aiTtsRemaining(NOW + TTS_USAGE_WINDOW_MS)).toBe(AI_LIMIT);
  });

  test("跟随当前 agent.tts；上限调低到已用次数以下为 0，tts 缺省为 0", () => {
    hydrateTtsUsage({ windowStartedAt: NOW, count: 10 });
    adoptTts(ttsConfig(30, 5));
    expect(aiTtsRemaining(NOW + 1)).toBe(15);
    adoptTts(ttsConfig(8, 0));
    expect(aiTtsRemaining(NOW + 1)).toBe(0);
    adoptTts(undefined);
    expect(aiTtsRemaining(NOW + 1)).toBe(0);
  });
});
