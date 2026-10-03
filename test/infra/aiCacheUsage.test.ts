import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { aiCacheUsageSink } from "../../packages/cache/perThread/aiCacheUsage";
import { logger } from "../../packages/infra/logger";
import {
  installAiCacheUsageSink,
  reportAiCacheUsage,
  reportAiCostUsage,
  reportAiSearchUsage,
  reportAnthropicUsage,
  reportGeminiUsage,
  reportGeminiInteractionUsage,
  reportXAiUsage,
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
    expect(reported[1]).toMatchObject({ kind: "tokens", cachedInputTokens: null });
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
      { kind: "tokens", capability: "ad_detect", provider: "google", model: "g", inputTokens: 50, cachedInputTokens: 0, outputTokens: 7 },
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

test("Anthropic 用量的输入含缓存写入与命中两项，命中取 cache_read；缓存字段为 null 时按 0 与未给出处理", () => {
  install();
  reportAnthropicUsage({ capability: "text", model: "m", usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 30, cache_read_input_tokens: 60 } as never });
  reportAnthropicUsage({ capability: "text", model: "m", usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null } as never });
  expect(reported.map(({ timestamp: _timestamp, ...rest }: AiCacheUsage) => rest)).toEqual([
    { kind: "tokens", capability: "text", provider: "anthropic", model: "m", inputTokens: 100, cachedInputTokens: 60, outputTokens: 2 },
    { kind: "tokens", capability: "text", provider: "anthropic", model: "m", inputTokens: 10, cachedInputTokens: null, outputTokens: 2 },
  ]);
});

test("独立检索次数只在大于 0 时上报为 search 记录", () => {
  install();
  reportAiSearchUsage({ capability: "web_search", provider: "google", model: "m", searchCalls: 0 });
  reportAiSearchUsage({ capability: "text", provider: "openai", model: "m", searchCalls: 3 });
  expect(reported.map(({ timestamp: _timestamp, ...rest }: AiCacheUsage) => rest)).toEqual([
    { kind: "search", capability: "text", provider: "openai", model: "m", searchCalls: 3 },
  ]);
});

test("一次响应的 token 与检索次数合并上报；token 缺失或非法时只保留检索次数", () => {
  install();
  for (const inputTokens of [12, undefined, -1]) {
    reportAiCacheUsage({ capability: "web_search", provider: "openai", model: "grok-4.7", inputTokens,
      cachedInputTokens: 4, outputTokens: 3, searchCalls: 8 });
  }
  expect(reported.map(({ timestamp: _timestamp, ...rest }: AiCacheUsage) => rest)).toEqual([
    { kind: "tokens", capability: "web_search", provider: "openai", model: "grok-4.7", inputTokens: 12,
      cachedInputTokens: 4, outputTokens: 3, searchCalls: 8 },
    { kind: "search", capability: "web_search", provider: "openai", model: "grok-4.7", searchCalls: 8 },
    { kind: "search", capability: "web_search", provider: "openai", model: "grok-4.7", searchCalls: 8 },
  ]);
});

test("Gemini 与 Anthropic 的缺失或畸形 token 用量保留有效检索次数", () => {
  install();
  for (const usage of [undefined, null, { input_tokens: -1, cache_creation_input_tokens: 2 }]) {
    reportAnthropicUsage({ capability: "web_search", model: "a", usage: usage as never, searchCalls: 2 });
  }
  for (const usage of [undefined, null, { promptTokenCount: 12, cachedContentTokenCount: 13, candidatesTokenCount: 1 }]) {
    reportGeminiUsage({ capability: "web_search", model: "g", usage: usage as never, searchCalls: 3 });
  }
  expect(reported).toHaveLength(6);
  expect(reported).toEqual([
    ...Array.from({ length: 3 }, (): ReturnType<typeof expect.objectContaining> => expect.objectContaining({ kind: "search", provider: "anthropic", searchCalls: 2 })),
    ...Array.from({ length: 3 }, (): ReturnType<typeof expect.objectContaining> => expect.objectContaining({ kind: "search", provider: "google", searchCalls: 3 })),
  ]);
});

test("检索次数非法时诊断且不上报，不把无法恢复的数值交给持久化线程", () => {
  install();
  const warning = spyOn(logger, "warn").mockImplementation((): void => {});
  try {
    for (const searchCalls of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      reportAiSearchUsage({ capability: "web_search", provider: "anthropic", model: "private-model", searchCalls });
    }
    expect(reported).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toBe("AI token usage unavailable: capability=web_search, provider=anthropic, reason=invalid.");
  } finally {
    warning.mockRestore();
  }
});

test("Anthropic 用量逐项校验后相加；畸形对象、非法分量与总量溢出均不上报", () => {
  install();
  for (const usage of [null, [], "invalid",
    { input_tokens: -1, cache_creation_input_tokens: 2, output_tokens: 1 },
    { input_tokens: 2, cache_creation_input_tokens: -1, output_tokens: 1 },
    { input_tokens: 0.5, cache_creation_input_tokens: 0.5, output_tokens: 1 },
    { input_tokens: 2, cache_read_input_tokens: -1, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 1, output_tokens: 1 },
  ]) {
    expect(() => reportAnthropicUsage({ capability: "text", model: "fixture", usage: usage as never })).not.toThrow();
  }
  expect(reported).toEqual([]);
});

describe("只给费用的计量与 xAI 用量口径", () => {
  test("费用计量校验为非负安全整数，缺失与非法分别诊断且不上报", () => {
    install();
    const warning = spyOn(logger, "warn").mockImplementation((): void => {});
    try {
      reportAiCostUsage({ capability: "image", provider: "openai", model: "x", costInUsdTicks: 5 });
      reportAiCostUsage({ capability: "image", provider: "openai", model: "x", costInUsdTicks: undefined });
      reportAiCostUsage({ capability: "image", provider: "google", model: "x", costInUsdTicks: -1 });
      expect(reported.map(({ timestamp: _timestamp, ...rest }: AiCacheUsage) => rest)).toEqual([
        { kind: "cost", capability: "image", provider: "openai", model: "x", costInUsdTicks: 5 },
      ]);
      expect(warning.mock.calls.map((call: unknown[]): unknown => call[0])).toEqual([
        "AI token usage unavailable: capability=image, provider=openai, reason=missing.",
        "AI token usage unavailable: capability=image, provider=google, reason=invalid.",
      ]);
    } finally {
      warning.mockRestore();
    }
  });

  test("xAI 给出 token 分量时只按 token 计入；两项都为空或缺席时按费用计入", () => {
    install();
    reportXAiUsage({
      capability: "image",
      model: "x",
      usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 3 }, cost_in_usd_ticks: 9 },
    });
    reportXAiUsage({ capability: "image", model: "x", usage: { input_tokens: null, output_tokens: null, cost_in_usd_ticks: 7 } });
    reportXAiUsage({ capability: "image", model: "x", usage: { cost_in_usd_ticks: 6 } });
    expect(reported.map(({ timestamp: _timestamp, ...rest }: AiCacheUsage) => rest)).toEqual([
      { kind: "tokens", capability: "image", provider: "openai", model: "x", inputTokens: 8, cachedInputTokens: 3, outputTokens: 2 },
      { kind: "cost", capability: "image", provider: "openai", model: "x", costInUsdTicks: 7 },
      { kind: "cost", capability: "image", provider: "openai", model: "x", costInUsdTicks: 6 },
    ]);
  });

  test("xAI 只给一项 token、usage 缺席或不是对象时不上报并诊断", () => {
    install();
    const warning = spyOn(logger, "warn").mockImplementation((): void => {});
    try {
      reportXAiUsage({ capability: "image", model: "x", usage: { input_tokens: 8, cost_in_usd_ticks: 7 } });
      reportXAiUsage({ capability: "text", model: "x", usage: undefined });
      reportXAiUsage({ capability: "summary", model: "x", usage: [] });
      expect(reported).toEqual([]);
      expect(warning.mock.calls.map((call: unknown[]): unknown => call[0])).toEqual([
        "AI token usage unavailable: capability=image, provider=openai, reason=missing.",
        "AI token usage unavailable: capability=text, provider=openai, reason=missing.",
        "AI token usage unavailable: capability=summary, provider=openai, reason=invalid.",
      ]);
    } finally {
      warning.mockRestore();
    }
  });
});
