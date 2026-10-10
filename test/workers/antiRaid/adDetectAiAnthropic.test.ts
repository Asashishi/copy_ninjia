/**
 * Anthropic 广告检测的客户端构造（含 headers 经 defaultHeaders 附加、fallback_model 挂拒答回退中间件）、
 * 结构化请求、用量（改道后记回退模型）、拒答立即放弃、其余不可用收尾与有界重采样。
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { loggerStub } from "../../helpers/loggerMock";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import type { AdDetectJsonRequestParams } from "../../../packages/types/antiRaid/adDetect";
import {
  AD_DETECT_ANTHROPIC_REQUEST_MAX_RETRIES,
  AD_DETECT_ANTHROPIC_REQUEST_TIMEOUT_MS,
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
  AD_DETECT_JSON_SCHEMA,
} from "../../../packages/consts/antiRaid/adDetect";

const create = mock(async (..._args: unknown[]): Promise<unknown> => response("end_turn"));
const constructions: unknown[] = [];
const errors: string[] = [];
const warnings: string[] = [];
const reported: AiCacheUsage[] = [];
const fallbackMiddleware = mock((fallbacks: unknown, options: unknown): unknown => ({ fallbacks, options }));
let provider: string = "anthropic";
let fallbackModel: string | undefined;

class FakeAPIError extends Error {}

function response(stopReason: string, text: string = '{"ad":false,"reason":"闲聊"}'): unknown {
  return {
    model: "claude-test", content: [{ type: "text", text }], stop_reason: stopReason,
    usage: { input_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 3 },
  };
}

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({
    error(message: unknown): void { errors.push(String(message)); },
    warn(message: unknown): void { warnings.push(String(message)); },
  }),
}));
const GATEWAY_HEADERS: Readonly<Record<string, string>> = { "cf-aig-authorization": "Bearer gateway-token" };
mock.module("../../../packages/config/agent", () => ({
  getAdDetectAgentConfig: () => ({
    provider, apiKey: "test-key", baseUrl: "https://test.invalid", headers: GATEWAY_HEADERS, model: "claude-test", fallbackModel,
  }),
}));
mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    static APIError: typeof FakeAPIError = FakeAPIError;
    readonly beta: { messages: { create: typeof create } } = { messages: { create } };
    constructor(options: unknown) { constructions.push(options); }
  },
  BetaFallbackState: class { index?: number; },
  betaRefusalFallbackMiddleware: fallbackMiddleware,
}));

const { requestAnthropicAdDetectJson } = await import("../../../packages/workers/antiRaid/adDetect/ai/anthropic");
const { adDetectAnthropicClientHolder } = await import("../../../packages/cache/workers/antiRaid/anthropic");
const { installAiCacheUsageSink } = await import("../../../packages/infra/aiCacheUsage");
const REQUEST: AdDetectJsonRequestParams = {
  model: "claude-test", instructions: "规则", fact: "事实", systemPrompt: "规则与事实",
  userContent: "待判定消息", temperature: 0, maxOutputTokens: 128, errorLabel: "Test ad detection",
};

beforeEach(() => {
  provider = "anthropic";
  fallbackModel = undefined;
  adDetectAnthropicClientHolder.current = null;
  constructions.length = 0;
  errors.length = 0;
  warnings.length = 0;
  fallbackMiddleware.mockClear();
  reported.length = 0;
  create.mockClear();
  create.mockImplementation(async (): Promise<unknown> => response("end_turn"));
  installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
});
afterEach(() => {
  adDetectAnthropicClientHolder.current = null;
  installAiCacheUsageSink(null);
});

test("规则缓存与系统事实独立，Schema 直接透传；复用客户端并逐响应计入含缓存的输入", async () => {
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBe('{"ad":false,"reason":"闲聊"}');
  await requestAnthropicAdDetectJson(REQUEST);
  expect(constructions).toStrictEqual([{
    apiKey: "test-key", baseURL: "https://test.invalid", defaultHeaders: GATEWAY_HEADERS, timeout: AD_DETECT_ANTHROPIC_REQUEST_TIMEOUT_MS,
    maxRetries: AD_DETECT_ANTHROPIC_REQUEST_MAX_RETRIES, middleware: undefined,
  }]);
  const body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming =
    create.mock.calls[0]![0] as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  expect(body.system).toEqual([{ type: "text", text: REQUEST.instructions, cache_control: { type: "ephemeral" } }, { type: "text", text: REQUEST.fact }]);
  expect(body.messages).toEqual([{ role: "user", content: REQUEST.userContent }]);
  expect(body.output_config?.format).toEqual({ type: "json_schema", schema: AD_DETECT_JSON_SCHEMA });
  expect(body).not.toHaveProperty("temperature");
  expect(reported).toHaveLength(2);
  expect(reported[0]).toMatchObject({ kind: "tokens", capability: "ad_detect", inputTokens: 14, cachedInputTokens: 5, cacheWriteInputTokens: 2, outputTokens: 3 });
});

test("配置了 fallback_model 时挂以它为唯一回退项的拒答回退中间件；每次请求都带 fallbackState", async () => {
  fallbackModel = "claude-fallback";
  await requestAnthropicAdDetectJson(REQUEST);
  expect(fallbackMiddleware).toHaveBeenCalledWith([{ model: "claude-fallback" }]);
  expect(constructions[0]).toHaveProperty("middleware", [{ fallbacks: [{ model: "claude-fallback" }], options: undefined }]);
  expect(create.mock.calls[0]?.[1]).toHaveProperty("fallbackState");
});

test("回退模型接手时用量记配置的回退模型并记一条改道日志", async () => {
  fallbackModel = "claude-fallback";
  const trigger = { type: "refusal", category: "cyber" };
  create.mockImplementationOnce(async (_body: unknown, options: unknown): Promise<unknown> => {
    (options as { fallbackState: { index?: number } }).fallbackState.index = 0;
    return {
      ...(response("end_turn") as object),
      model: "claude-fallback",
      content: [{ type: "fallback", from: { model: "claude-test" }, to: { model: "claude-fallback" }, trigger }, { type: "text", text: '{"ad":true,"reason":"引流"}' }],
    };
  });
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBe('{"ad":true,"reason":"引流"}');
  expect(reported[0]).toMatchObject({ capability: "ad_detect", model: "claude-fallback" });
  expect(warnings).toEqual([`Test ad detection fell back after a refusal: from=claude-test, to=claude-fallback, trigger=${JSON.stringify(trigger)}, fallback_credit=null.`]);
});

test("回退模型也拒答：记改道 warn，日志里的 stop_details 不含回退额度令牌", async () => {
  fallbackModel = "claude-fallback";
  const stopDetails = { type: "refusal", category: "cyber", explanation: null, fallback_has_prefill_claim: false };
  create.mockImplementationOnce(async (_body: unknown, options: unknown): Promise<unknown> => {
    (options as { fallbackState: { index?: number } }).fallbackState.index = 0;
    return { ...(response("refusal", "") as object), model: "claude-fallback", stop_details: { ...stopDetails, fallback_credit_token: "credit-token" } };
  });
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBeNull();
  expect(warnings).toEqual([
    "Test ad detection fell back after a refusal: from=claude-test, to=claude-fallback; the fallback model returned stop_reason=refusal.",
  ]);
  expect(errors.join("\n")).toContain(`details=${JSON.stringify(stopDetails)}`);
  expect(errors.join("\n")).not.toContain("credit-token");
});

test("拒答立即放弃不重采样，日志带模型与 stop_details 整个对象", async () => {
  const stopDetails = { type: "refusal", category: "cyber", explanation: null };
  create.mockImplementation(async (): Promise<unknown> => ({ ...(response("refusal", "") as object), stop_details: stopDetails }));
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBeNull();
  expect(create).toHaveBeenCalledTimes(1);
  expect(reported).toHaveLength(1);
  expect(errors).toEqual([
    `Test ad detection produced no usable body in 1 attempt(s) (model=claude-test, stop_reason=refusal, ` +
    `details=${JSON.stringify(stopDetails)}, hasPartialText=false, max_tokens=${REQUEST.maxOutputTokens}).`,
  ]);
});

test.each(["max_tokens", "model_context_window_exceeded", "end_turn"])("%s 不可用或空正文有界重采样，每次响应都记用量", async (stopReason: string) => {
  create.mockImplementation(async (): Promise<unknown> => response(stopReason, stopReason === "end_turn" ? " " : '{"ad":true,"reason":"部分"}'));
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBeNull();
  expect(create).toHaveBeenCalledTimes(AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS);
  expect(reported).toHaveLength(AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS);
  expect(errors).toHaveLength(1);
});

test("耗尽后的日志带最后一次的模型与收尾原因；没有详情时省略 details", async () => {
  create.mockImplementation(async (): Promise<unknown> => response("max_tokens", "{"));
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBeNull();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(`in ${AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS} attempt(s) (model=claude-test, stop_reason=max_tokens, hasPartialText=true,`);
});

test("首次正文为空，后续可用时返回完整正文", async () => {
  create.mockResolvedValueOnce(response("end_turn", ""));
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBe('{"ad":false,"reason":"闲聊"}');
  expect(errors).toEqual([]);
});

test.each([new FakeAPIError("429 unavailable"), new Error("unavailable")])("请求异常不叠加业务重试", async (error: Error) => {
  create.mockRejectedValueOnce(error);
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBeNull();
  expect(create).toHaveBeenCalledTimes(1);
  expect(errors).toHaveLength(1);
});

test("未配置 Anthropic 的能力拒绝构造客户端", async () => {
  provider = "openai";
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBeNull();
  expect(create).not.toHaveBeenCalled();
  expect(constructions).toEqual([]);
});
