/**
 * Anthropic Messages 的底层收发：按能力缓存客户端、显式超时与重试、用量映射（输入含缓存两项、
 * 命中取 cache_read）、HTTP 错误归因与不可用收尾（截断、拒答、上下文超长）的分类；pause_turn
 * 按成功交回由调用方续发。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import type { AgentDeploymentConfig } from "../../../packages/types/config";
import type Anthropic from "@anthropic-ai/sdk";

const constructions: unknown[] = [];
const create = mock(async (..._args: unknown[]): Promise<unknown> => message("end_turn"));
const loggerError = mock((..._args: unknown[]): void => {});

class FakeAPIError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function message(stopReason: string, text: string = "正文"): unknown {
  return {
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: null, cache_read_input_tokens: 5 },
  };
}

mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));
mock.module("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages: { create: typeof create } = { create };
    constructor(options: unknown) { constructions.push(options); }
    static APIError: typeof FakeAPIError = FakeAPIError;
  }
  return { default: FakeAnthropic, APIError: FakeAPIError };
});

const { requestAnthropicMessage, requestAnthropicTextResult } = await import("../../../packages/aiChat/anthropic/client");
const { anthropicClientCache } = await import("../../../packages/cache/workers/aiChat/anthropic");
const { adoptAgentDeploymentConfig, getAgentDeploymentConfig } = await import("../../../packages/config/agent");
const { installAiCacheUsageSink } = await import("../../../packages/infra/aiCacheUsage");
const { searchAnthropicWeb } = await import("../../../packages/aiChat/anthropic/search");
const {
  ANTHROPIC_REQUEST_MAX_RETRIES,
  ANTHROPIC_REQUEST_TIMEOUTS_MS,
} = await import("../../../packages/consts/aiChat/anthropic");

const PRELOADED: AgentDeploymentConfig = getAgentDeploymentConfig();
const CAPABILITY = { provider: "anthropic", apiKey: "anthropic-key", baseUrl: "https://proxy.example/anthropic", headers: undefined, model: "claude-test" } as const;
const reported: AiCacheUsage[] = [];

function body(): never {
  return { model: "claude-test", max_tokens: 16, messages: [{ role: "user", content: "hi" }] } as never;
}

beforeEach(() => {
  adoptAgentDeploymentConfig({ ...PRELOADED, text: CAPABILITY, media: CAPABILITY, webSearch: { ...CAPABILITY, maxCallsPerUse: 7 } });
  anthropicClientCache.current = null;
  constructions.length = 0;
  create.mockClear();
  create.mockImplementation(async (): Promise<unknown> => message("end_turn"));
  loggerError.mockClear();
  reported.length = 0;
  installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
});

afterEach(() => {
  installAiCacheUsageSink(null);
  adoptAgentDeploymentConfig(PRELOADED);
  anthropicClientCache.current = null;
});

describe("requestAnthropicMessage", () => {
  test("按能力构造并缓存客户端，显式给出超时与重试；用量输入含缓存两项、命中取 cache_read", async () => {
    await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" });
    await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" });
    await requestAnthropicMessage({ capability: "media", buildBody: body, errorLabel: "test" });
    expect(constructions).toEqual([
      { apiKey: "anthropic-key", baseURL: "https://proxy.example/anthropic", timeout: ANTHROPIC_REQUEST_TIMEOUTS_MS.text, maxRetries: ANTHROPIC_REQUEST_MAX_RETRIES },
      { apiKey: "anthropic-key", baseURL: "https://proxy.example/anthropic", timeout: ANTHROPIC_REQUEST_TIMEOUTS_MS.media, maxRetries: ANTHROPIC_REQUEST_MAX_RETRIES },
    ]);
    expect(reported[0]).toMatchObject({ kind: "tokens", capability: "text", provider: "anthropic", model: "claude-test", inputTokens: 12, cachedInputTokens: 5, outputTokens: 3 });
  });

  test("能力没选 anthropic 时在 try 内失败，归一成请求失败并记日志", async () => {
    adoptAgentDeploymentConfig(PRELOADED);
    expect(PRELOADED.media.provider).not.toBe("anthropic");
    expect(await requestAnthropicMessage({ capability: "media", buildBody: body, errorLabel: "test" }))
      .toEqual({ ok: false, failureKind: "request" });
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  test("网页搜索完整链路合并 token 与检索次数；工具错误仍记 token，缺 usage 时保留成功检索次数", async () => {
    const success: Anthropic.WebSearchToolResultBlock = { type: "web_search_tool_result", tool_use_id: "s", caller: { type: "direct" }, content: [] };
    const failure: Anthropic.WebSearchToolResultBlock = { type: "web_search_tool_result", tool_use_id: "s", caller: { type: "direct" }, content: { type: "web_search_tool_result_error", error_code: "unavailable" } };
    for (const block of [success, failure]) {
      create.mockResolvedValueOnce({
        content: [{ type: "text", text: "结论" }, block], stop_reason: "end_turn",
        usage: { input_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 3,
          server_tool_use: { web_search_requests: block === success ? 2 : 0 } },
      });
      expect(await searchAnthropicWeb("web_search", { instruction: "i", query: "q" })).toMatchObject({ ok: block === success });
    }
    create.mockResolvedValueOnce({ content: [success], stop_reason: "end_turn" });
    expect(await searchAnthropicWeb("web_search", { instruction: "i", query: "q" })).toMatchObject({ ok: true, searchCalls: 1 });
    expect(reported).toHaveLength(3);
    expect(reported[0]).toMatchObject({ kind: "tokens", capability: "web_search", inputTokens: 14, cachedInputTokens: 5, outputTokens: 3, searchCalls: 2 });
    expect(reported[1]).toMatchObject({ kind: "tokens", inputTokens: 14, outputTokens: 3 });
    expect(reported[2]).toMatchObject({ kind: "search", searchCalls: 1 });
  });

  test.each([
    [404, "misconfigured"],
    [400, "rejected"],
    [529, "request"],
  ] as const)("HTTP %d 归为 %s", async (status, failureKind) => {
    create.mockImplementationOnce(async (): Promise<unknown> => { throw new FakeAPIError(status, `${status} error`); });
    expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" })).toEqual({ ok: false, failureKind });
  });

  test("截断、拒答与上下文超长按产出不可用交回原响应；pause_turn 按成功交回", async () => {
    for (const stopReason of ["max_tokens", "refusal", "model_context_window_exceeded"]) {
      create.mockImplementationOnce(async (): Promise<unknown> => message(stopReason));
      expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" }))
        .toMatchObject({ ok: false, failureKind: "response", stopReason });
    }
    create.mockImplementationOnce(async (): Promise<unknown> => message("pause_turn"));
    expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" })).toMatchObject({ ok: true });
  });

  test("调用方已取消时不发请求，按请求失败结算且不记日志", async () => {
    const controller: AbortController = new AbortController();
    controller.abort();
    expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test", signal: controller.signal }))
      .toEqual({ ok: false, failureKind: "request" });
    expect(create).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });
});

describe("requestAnthropicTextResult", () => {
  test("正文经 normalize 后交回；清洗后为空按可重采样失败", async () => {
    expect(await requestAnthropicTextResult({ capability: "text", buildBody: body, errorLabel: "t", normalize: (text: string): string => `[${text}]` }))
      .toEqual({ ok: true, text: "[正文]" });
    expect(await requestAnthropicTextResult({ capability: "text", buildBody: body, errorLabel: "t", normalize: (): string => "" }))
      .toEqual({ ok: false, retryable: true });
  });
});

describe("会话固定的客户端", () => {
  test("传入 client 时请求只走它，不按能力构造或取用缓存的客户端", async () => {
    const pinnedCreate = mock(async (..._args: unknown[]): Promise<unknown> => message("end_turn"));
    const pinned = { messages: { create: pinnedCreate } } as never;

    const result = await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test", client: pinned });

    expect(result.ok).toBeTrue();
    expect(pinnedCreate).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(constructions).toEqual([]);
    expect(anthropicClientCache.current).toBeNull();
  });
});
