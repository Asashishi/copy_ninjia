import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { aiCacheUsageSink } from "../../packages/cache/perThread/aiCacheUsage";
import { logger } from "../../packages/infra/logger";
import {
  installAiCacheUsageSink,
  reportAiCacheUsage,
  reportGeminiUsage,
  reportGeminiInteractionUsage,
} from "../../packages/infra/aiCacheUsage";
import type { AiCacheUsage } from "../../packages/types/aiCache";

const reported: AiCacheUsage[] = [];

function install(): void {
  installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
}

afterEach(() => {
  installAiCacheUsageSink(null);
  reported.length = 0;
});

describe("AI 缓存用量上报边界", () => {
  test("没有出口时不计数；装上出口后带时间戳上报", () => {
    reportAiCacheUsage({ capability: "text", provider: "openai", model: "m", inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 });
    expect(aiCacheUsageSink.current).toBeNull();

    install();
    const before: number = Date.now();
    reportAiCacheUsage({ capability: "text", provider: "openai", model: "m", inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 });
    reportAiCacheUsage({ capability: "ad_detect", provider: "openai", model: "m", inputTokens: 10, cachedInputTokens: undefined, outputTokens: 2 });
    expect(reported).toHaveLength(2);
    expect(reported[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(reported[0]).toMatchObject({ capability: "text", inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 });
    expect(reported[1]!.cachedInputTokens).toBeNull();
  });

  test.each([
    ["输入缺失", [undefined, 1, 1]],
    ["输出为负", [10, 1, -1]],
    ["命中为小数", [10, 1.5, 1]],
    ["命中超过输入", [10, 11, 1]],
    ["命中不是数字", [10, "5", 1]],
  ] as const)("%s 时整条丢弃", (_label: string, [inputTokens, cachedInputTokens, outputTokens]: readonly unknown[]) => {
    install();
    reportAiCacheUsage({ capability: "text", provider: "openai", model: "m", inputTokens, cachedInputTokens, outputTokens });
    expect(reported).toEqual([]);
  });

  test("Gemini 用量：缺 usageMetadata 不上报，缺命中数按 0，输出计入思考", () => {
    install();
    reportGeminiUsage({ capability: "ad_detect", model: "g", usage: undefined });
    reportGeminiUsage({ capability: "ad_detect", model: "g", usage: { candidatesTokenCount: 3 } });
    reportGeminiUsage({ capability: "ad_detect", model: "g", usage: { promptTokenCount: 50, candidatesTokenCount: 3, thoughtsTokenCount: 4 } });
    expect(reported.map(({ timestamp: _timestamp, ...rest }: AiCacheUsage) => rest)).toEqual([
      { capability: "ad_detect", provider: "google", model: "g", inputTokens: 50, cachedInputTokens: 0, outputTokens: 7 },
    ]);
  });
});

test("Interactions 独立思考 token 计入输出，未给缓存数保持未知", () => {
  install();
  reportGeminiInteractionUsage({ capability: "tts", model: "speech", usage: {
    total_input_tokens: 20, total_output_tokens: 100, total_thought_tokens: 3, total_cached_tokens: 5,
  } });
  reportGeminiInteractionUsage({ capability: "tts", model: "speech", usage: { total_input_tokens: 4, total_output_tokens: 7 } });
  reportGeminiInteractionUsage({ capability: "tts", model: "speech", usage: undefined });
  expect(reported).toMatchObject([
    { inputTokens: 20, cachedInputTokens: 5, outputTokens: 103 },
    { inputTokens: 4, cachedInputTokens: null, outputTokens: 7 },
  ]);
});

test("Gemini 非法分量不能相加后掩盖，缺输出保持未知，畸形 usage 不影响业务", () => {
  install();
  for (const usage of [null, "invalid", [], { promptTokenCount: 4 },
    { promptTokenCount: 4, candidatesTokenCount: -1, thoughtsTokenCount: 2 },
    { promptTokenCount: 4, candidatesTokenCount: 1, cachedContentTokenCount: null }]) {
    expect(() => reportGeminiUsage({ capability: "text", model: "fixture", usage: usage as any })).not.toThrow();
  }
  for (const usage of [null, "invalid", [], { total_input_tokens: 4 },
    { total_input_tokens: 4, total_output_tokens: -1, total_thought_tokens: 2 },
    { total_input_tokens: 4, total_output_tokens: 1, total_thought_tokens: null }]) {
    expect(() => reportGeminiInteractionUsage({ capability: "tts", model: "fixture", usage: usage as any })).not.toThrow();
  }
  expect(reported).toEqual([]);
});

test("用量诊断按固定维度去重、不回显模型或异常，重装出口后重新诊断", () => {
  const warning = spyOn(logger, "warn").mockImplementation((): void => {});
  try {
    const report = { capability: "image", provider: "openai", model: "private-model", inputTokens: 1, cachedInputTokens: undefined, outputTokens: 2 } as const;
    installAiCacheUsageSink(null);
    reportAiCacheUsage(report);
    reportAiCacheUsage(report);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain("reason=sink");
    installAiCacheUsageSink((): never => { throw new Error("secret-response"); });
    expect(() => reportAiCacheUsage(report)).not.toThrow();
    reportAiCacheUsage(report);
    reportAiCacheUsage({ ...report, inputTokens: undefined });
    reportAiCacheUsage({ ...report, outputTokens: -1 });
    expect(warning.mock.calls.map((call: unknown[]): unknown => call[0])).toEqual([
      "AI token usage unavailable: capability=image, provider=openai, reason=sink.",
      "AI token usage unavailable: capability=image, provider=openai, reason=transport.",
      "AI token usage unavailable: capability=image, provider=openai, reason=missing.",
      "AI token usage unavailable: capability=image, provider=openai, reason=invalid.",
    ]);
  } finally {
    warning.mockRestore();
  }
});
