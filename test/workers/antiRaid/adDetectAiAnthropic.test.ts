/** Anthropic 广告检测的结构化请求、用量、不可用收尾与有界重采样。 */
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
const reported: AiCacheUsage[] = [];
let provider: string = "anthropic";

class FakeAPIError extends Error {}

function response(stopReason: string, text: string = '{"ad":false,"reason":"闲聊"}'): unknown {
  return {
    content: [{ type: "text", text }], stop_reason: stopReason,
    usage: { input_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 3 },
  };
}

mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error(message: unknown): void { errors.push(String(message)); } }),
}));
mock.module("../../../packages/config/agent", () => ({
  getAdDetectAgentConfig: () => ({ provider, apiKey: "test-key", baseUrl: "https://test.invalid", model: "claude-test" }),
}));
mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    static APIError: typeof FakeAPIError = FakeAPIError;
    readonly messages: { create: typeof create } = { create };
    constructor(options: unknown) { constructions.push(options); }
  },
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
  adDetectAnthropicClientHolder.current = null;
  constructions.length = 0;
  errors.length = 0;
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
  expect(constructions).toEqual([{ apiKey: "test-key", baseURL: "https://test.invalid", timeout: AD_DETECT_ANTHROPIC_REQUEST_TIMEOUT_MS, maxRetries: AD_DETECT_ANTHROPIC_REQUEST_MAX_RETRIES }]);
  const body: Anthropic.MessageCreateParamsNonStreaming = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
  expect(body.system).toEqual([{ type: "text", text: REQUEST.instructions, cache_control: { type: "ephemeral" } }, { type: "text", text: REQUEST.fact }]);
  expect(body.messages).toEqual([{ role: "user", content: REQUEST.userContent }]);
  expect(body.output_config?.format).toEqual({ type: "json_schema", schema: AD_DETECT_JSON_SCHEMA });
  expect(body).not.toHaveProperty("temperature");
  expect(reported).toHaveLength(2);
  expect(reported[0]).toMatchObject({ kind: "tokens", capability: "ad_detect", inputTokens: 14, cachedInputTokens: 5, outputTokens: 3 });
});

test.each(["max_tokens", "refusal", "model_context_window_exceeded", "end_turn"])("%s 不可用或空正文有界重采样，每次响应都记用量", async (stopReason: string) => {
  create.mockImplementation(async (): Promise<unknown> => response(stopReason, stopReason === "end_turn" ? " " : '{"ad":true,"reason":"部分"}'));
  expect(await requestAnthropicAdDetectJson(REQUEST)).toBeNull();
  expect(create).toHaveBeenCalledTimes(AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS);
  expect(reported).toHaveLength(AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS);
  expect(errors).toHaveLength(1);
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
