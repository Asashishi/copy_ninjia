/**
 * Anthropic Messages（beta 端点）的底层收发：按能力缓存客户端、显式超时与重试、能力 headers 经
 * defaultHeaders 附加、fallback_model 经 betaRefusalFallbackMiddleware 挂到客户端、用量映射（输入含缓存
 * 两项、命中取 cache_read，改道后记配置的回退模型）、HTTP 错误归因、拒答归为 refused 与其余不可用收尾（截断、
 * 上下文超长）的分类；pause_turn 按成功交回由调用方续发。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import type { AgentDeploymentConfig } from "../../../packages/types/config";
import type Anthropic from "@anthropic-ai/sdk";

const constructions: unknown[] = [];
const create = mock(async (..._args: unknown[]): Promise<unknown> => message("end_turn"));
const loggerError = mock((..._args: unknown[]): void => {});
const loggerWarn = mock((..._args: unknown[]): void => {});
const fallbackMiddleware = mock((fallbacks: unknown, options: unknown): unknown => ({ fallbacks, options }));

class FakeAPIError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function message(stopReason: string, text: string = "正文"): unknown {
  return {
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: null, cache_read_input_tokens: 5 },
  };
}

mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError, warn: loggerWarn }) }));
mock.module("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta: { messages: { create: typeof create } } = { messages: { create } };
    constructor(options: unknown) { constructions.push(options); }
    static APIError: typeof FakeAPIError = FakeAPIError;
  }
  class FakeFallbackState {
    index?: number;
  }
  return {
    default: FakeAnthropic,
    APIError: FakeAPIError,
    BetaFallbackState: FakeFallbackState,
    betaRefusalFallbackMiddleware: fallbackMiddleware,
  };
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
const CAPABILITY = {
  provider: "anthropic", apiKey: "anthropic-key", baseUrl: "https://proxy.example/anthropic", headers: undefined,
  model: "claude-test", fallbackModel: undefined,
} as const;
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
  loggerWarn.mockClear();
  fallbackMiddleware.mockClear();
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

  test("能力配置的 headers 作为 defaultHeaders 交给 SDK，未配置的能力不带", async () => {
    const headers: Readonly<Record<string, string>> = { "cf-aig-authorization": "Bearer gateway-token" };
    adoptAgentDeploymentConfig({ ...PRELOADED, text: { ...CAPABILITY, headers }, media: CAPABILITY });
    await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" });
    await requestAnthropicMessage({ capability: "media", buildBody: body, errorLabel: "test" });
    expect(constructions[0]).toStrictEqual({
      apiKey: "anthropic-key", baseURL: "https://proxy.example/anthropic", defaultHeaders: headers,
      timeout: ANTHROPIC_REQUEST_TIMEOUTS_MS.text, maxRetries: ANTHROPIC_REQUEST_MAX_RETRIES, middleware: undefined,
    });
    expect(constructions[1]).toHaveProperty("defaultHeaders", undefined);
  });

  test("配置了 fallback_model 的能力挂以它为唯一回退项的拒答回退中间件，未配置的能力不挂", async () => {
    adoptAgentDeploymentConfig({ ...PRELOADED, text: { ...CAPABILITY, fallbackModel: "claude-fallback" }, media: CAPABILITY });
    await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" });
    await requestAnthropicMessage({ capability: "media", buildBody: body, errorLabel: "test" });
    expect(fallbackMiddleware).toHaveBeenCalledTimes(1);
    expect(fallbackMiddleware).toHaveBeenCalledWith([{ model: "claude-fallback" }]);
    expect(constructions[0]).toHaveProperty("middleware", [{ fallbacks: [{ model: "claude-fallback" }], options: undefined }]);
    expect(constructions[1]).toHaveProperty("middleware", undefined);
  });

  test("每次请求都带 fallbackState；改道后用量记配置的回退模型并记一条改道日志，未改道记请求体的 model", async () => {
    adoptAgentDeploymentConfig({ ...PRELOADED, text: { ...CAPABILITY, fallbackModel: "claude-fallback" } });
    const trigger = { type: "refusal", category: "cyber" };
    create.mockImplementationOnce(async (_body: unknown, options: unknown): Promise<unknown> => {
      (options as { fallbackState: { index?: number } }).fallbackState.index = 0;
      return {
        ...(message("end_turn") as object),
        model: "claude-fallback",
        content: [{ type: "fallback", from: { model: "claude-test" }, to: { model: "claude-fallback" }, trigger }, { type: "text", text: "接手" }],
      };
    });
    expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" })).toMatchObject({ ok: true });
    expect(create.mock.calls[0]?.[1]).toHaveProperty("fallbackState");
    expect(reported[0]).toMatchObject({ capability: "text", model: "claude-fallback" });
    expect(loggerWarn).toHaveBeenCalledWith(`test fell back after a refusal: from=claude-test, to=claude-fallback, trigger=${JSON.stringify(trigger)}, fallback_credit=null.`);

    await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" });
    expect(reported[1]).toMatchObject({ model: "claude-test" });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  test("调用方传入的 fallbackState 原样交给 SDK", async () => {
    const fallbackState = { index: 0 } as never;
    await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test", fallbackState });
    expect(create.mock.calls[0]?.[1]).toHaveProperty("fallbackState", fallbackState);
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
    expect(reported[0]).toMatchObject({ kind: "tokens", capability: "web_search", inputTokens: 14, cachedInputTokens: 5, cacheWriteInputTokens: 2, outputTokens: 3, searchCalls: 2 });
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

  test("截断与上下文超长按产出不可用、拒答按 refused 交回原响应；pause_turn 按成功交回", async () => {
    for (const stopReason of ["max_tokens", "model_context_window_exceeded"]) {
      create.mockImplementationOnce(async (): Promise<unknown> => message(stopReason));
      expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" }))
        .toMatchObject({ ok: false, failureKind: "response", stopReason });
    }
    create.mockImplementationOnce(async (): Promise<unknown> => message("refusal"));
    expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" }))
      .toMatchObject({ ok: false, failureKind: "refused", stopReason: "refusal" });
    create.mockImplementationOnce(async (): Promise<unknown> => message("pause_turn"));
    expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" })).toMatchObject({ ok: true });
  });

  test("拒答把 stop_details 整个对象以 details= 记进日志并随失败结果交回；没有详情时省略", async () => {
    const stopDetails = { type: "refusal", category: "cyber", explanation: "declined" };
    create.mockImplementationOnce(async (): Promise<unknown> => ({ ...(message("refusal", "") as object), stop_details: stopDetails }));
    expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" }))
      .toMatchObject({ ok: false, failureKind: "refused", stopReason: "refusal", stopDetails: JSON.stringify(stopDetails) });
    expect(loggerError).toHaveBeenLastCalledWith(
      `test returned an unusable response: model=claude-test, stop_reason=refusal, details=${JSON.stringify(stopDetails)} (hasPartialText=false).`
    );

    create.mockImplementationOnce(async (): Promise<unknown> => ({ ...(message("max_tokens") as object), stop_details: null }));
    expect(await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test" }))
      .toMatchObject({ ok: false, failureKind: "response", stopReason: "max_tokens", stopDetails: undefined });
    expect(loggerError).toHaveBeenLastCalledWith(
      "test returned an unusable response: model=claude-test, stop_reason=max_tokens (hasPartialText=true)."
    );
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

  test("拒答按不可重采样的 refused 失败交回，媒体能力也不带模态结论", async () => {
    for (const capability of ["summary", "media"] as const) {
      create.mockImplementationOnce(async (): Promise<unknown> => message("refusal", ""));
      expect(await requestAnthropicTextResult({ capability, buildBody: body, errorLabel: "t", normalize: (text: string): string => text }))
        .toEqual({ ok: false, retryable: false, refused: true });
    }
  });
});

describe("searchAnthropicWeb 的拒答", () => {
  test("拒答按带 refused 的失败交回", async () => {
    create.mockImplementationOnce(async (): Promise<unknown> => message("refusal", ""));
    expect(await searchAnthropicWeb("web_search", { instruction: "i", query: "q" })).toEqual({ ok: false, searchCalls: 0, refused: true });
  });
});

describe("会话固定的客户端", () => {
  test("传入 client 时请求只走它，不按能力构造或取用缓存的客户端", async () => {
    const pinnedCreate = mock(async (..._args: unknown[]): Promise<unknown> => message("end_turn"));
    const pinned = { sdk: { beta: { messages: { create: pinnedCreate } } }, fallbackModel: undefined } as never;

    const result = await requestAnthropicMessage({ capability: "text", buildBody: body, errorLabel: "test", client: pinned });

    expect(result.ok).toBeTrue();
    expect(pinnedCreate).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(constructions).toEqual([]);
    expect(anthropicClientCache.current).toBeNull();
  });
});
