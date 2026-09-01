/**
 * OpenAI 底层收发的失败分类与日志。整条降级链都压在这里的
 * request/response 二分上：「SDK 已耗尽 HTTP 重试」不允许业务层再套一层完整
 * 请求，「HTTP 成功但产出不可用」才允许重采样。口径与
 * test/aiChat/gemini/client.test.ts 一一对应。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type OpenAI from "openai";

const create = mock(async (..._args: unknown[]): Promise<unknown> => ({
  status: "completed",
  error: null,
  incomplete_details: null,
  output: [{ type: "message", content: [] }],
  output_text: "ok",
}));
const loggerError = mock((..._args: unknown[]): void => {});
const createdOptions: Record<string, unknown>[] = [];

class FakeApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class FakeOpenAI {
  static readonly APIError = FakeApiError;
  readonly responses = { create };
  constructor(options: Record<string, unknown>) {
    createdOptions.push(options);
  }
}

mock.module("openai", () => ({ default: FakeOpenAI, APIError: FakeApiError }));
// 端点来自按能力部署配置而非 env，见 packages/config/agent.ts。
mock.module("../../../packages/config/agent", () => ({
  getAgentDeploymentConfig: () => ({
    text: { provider: "openai", apiKey: "text-key", baseUrl: "https://text.invalid/v1", model: "reply-model" },
    summary: { provider: "openai", apiKey: "summary-key", baseUrl: "https://gateway.invalid/v1", model: "summary-model" },
    media: { provider: "openai", apiKey: "media-key", baseUrl: "https://gateway.invalid/v1", model: "media-model" },
    image: { provider: "openai", apiKey: "image-key", baseUrl: "https://image.invalid/v1", model: "image-model", imageProtocol: "openai-standard" },
  }),
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

const {
  getOpenAiClient,
  requestOpenAiResult,
  requestOpenAiTextResult,
} = await import("../../../packages/aiChat/openai/client");
const { openAiClientCache } = await import("../../../packages/cache/workers/aiChat/openai");
const {
  OPENAI_REQUEST_MAX_RETRIES,
  OPENAI_REQUEST_TIMEOUT_MS,
} = await import("../../../packages/consts/aiChat/openai");

const BODY = { model: "test-model", input: "hi" } as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming;

function respondWith(overrides: Record<string, unknown>): void {
  create.mockResolvedValueOnce({
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [{ type: "message", content: [] }],
    output_text: "",
    ...overrides,
  });
}

beforeEach(() => {
  openAiClientCache.current = null;
  create.mockClear();
  loggerError.mockClear();
  createdOptions.length = 0;
});

afterEach(() => {
  openAiClientCache.current = null;
});

describe("客户端构造", () => {
  test("超时与重试次数由 consts 固定，baseURL 取自 config/agent.json 的对应能力", () => {
    expect(OPENAI_REQUEST_MAX_RETRIES).toBe(5);
    getOpenAiClient("summary");
    // 每项能力独立持有认证；即使端点相同也不能误用另一项的 key。
    getOpenAiClient("media");
    getOpenAiClient("summary");
    expect(createdOptions).toHaveLength(2);
    expect(createdOptions[0]).toEqual({
      apiKey: "summary-key",
      baseURL: "https://gateway.invalid/v1",
      timeout: OPENAI_REQUEST_TIMEOUT_MS,
      maxRetries: OPENAI_REQUEST_MAX_RETRIES,
    });
    expect(createdOptions[1]).toEqual({
      apiKey: "media-key",
      baseURL: "https://gateway.invalid/v1",
      timeout: OPENAI_REQUEST_TIMEOUT_MS,
      maxRetries: OPENAI_REQUEST_MAX_RETRIES,
    });
  });
});

describe("整次调用的 deadline", () => {
  test("SDK 每次尝试各自的 timeout 之外，另有一份覆盖全部重试的 deadline", async () => {
    await requestOpenAiResult({ capability: "summary", buildBody: () => BODY, errorLabel: "AI test API" });

    const options = create.mock.calls[0]![1] as { readonly signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
  });

  test("调用方取消信号与 deadline 合成后下传，不被替换掉", async () => {
    const controller: AbortController = new AbortController();
    await requestOpenAiResult({
      capability: "summary", buildBody: () => BODY, errorLabel: "AI test API", signal: controller.signal,
    });

    const passed: AbortSignal | undefined = (create.mock.calls[0]![1] as { readonly signal?: AbortSignal }).signal;
    expect(passed).not.toBe(controller.signal);
    expect(passed?.aborted).toBe(false);
    controller.abort();
    expect(passed?.aborted).toBe(true);
  });
});

describe("失败分类", () => {
  test("APIError 记一行带状态码的日志，并归类成请求失败", async () => {
    create.mockRejectedValueOnce(new FakeApiError(502, "Upstream request failed"));
    const result = await requestOpenAiResult({ capability: "summary", buildBody: () => BODY, errorLabel: "AI test API" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failureKind).toBe("request");
    expect(loggerError).toHaveBeenCalledWith("AI test API error: 502 Upstream request failed");
  });

  test("非 APIError 也归类成请求失败，并把原始错误交给日志", async () => {
    const error = new Error("socket hang up");
    create.mockRejectedValueOnce(error);
    const result = await requestOpenAiResult({ capability: "summary", buildBody: () => BODY, errorLabel: "AI test API" });

    expect(result.ok === false && result.failureKind).toBe("request");
    expect(loggerError).toHaveBeenCalledWith("Error calling AI test API:", error);
  });

  test("调用方主动取消时不记错误日志", async () => {
    const controller: AbortController = new AbortController();
    create.mockImplementationOnce(async (): Promise<unknown> => {
      controller.abort();
      throw new Error("aborted");
    });
    const result = await requestOpenAiResult({
      capability: "summary",
      buildBody: () => BODY,
      errorLabel: "AI test API",
      signal: controller.signal,
    });

    expect(result.ok === false && result.diagnostic).toBe("request aborted");
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("HTTP 成功但产出不可用时归类成响应失败并带上收尾原因", async () => {
    respondWith({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] });
    const result = await requestOpenAiResult({ capability: "summary", buildBody: () => BODY, errorLabel: "AI test API" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failureKind).toBe("response");
    expect(result.ok === false && result.finishReason).toBe("incomplete:content_filter");
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("AI test API returned an unusable response: status=incomplete, reason=content_filter")
    );
  });

  test("被 max_output_tokens 腰斩时点名记录 token 诊断", async () => {
    respondWith({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: "半截",
      usage: { output_tokens_details: { reasoning_tokens: 1234 } },
    });
    await requestOpenAiResult({
      capability: "summary",
      buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({ ...BODY, max_output_tokens: 99 }),
      errorLabel: "AI test API",
    });

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("truncated by max_output_tokens (hasPartialText=true, reasoning_tokens=1234, max_output_tokens=99)")
    );
  });

  test("正常收尾时不记任何错误日志", async () => {
    respondWith({ output_text: "正文" });
    const result = await requestOpenAiResult({ capability: "summary", buildBody: () => BODY, errorLabel: "AI test API" });
    expect(result.ok).toBe(true);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("请求体构造抛错（config/agent.json 写坏）归类成请求失败，而不是掀给调用方", async () => {
    const configError = new Error("config/agent.json: $.agent.summary must be a valid capability");
    const result = await requestOpenAiResult({
      capability: "summary",
      buildBody: (): never => { throw configError; },
      errorLabel: "AI test API",
    });

    // 关键在于「不 reject」：抛出去就绕过了上层为 ok:false 准备的全部诊断与
    // 降级路径，群里只剩沉默、日志里一行都没有（见 client.ts 的 JSDoc）。
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failureKind).toBe("request");
    expect(create).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith("Error calling AI test API:", configError);
  });
});

describe("文本请求的重试边界", () => {
  test("media 被确定性 4xx 拒绝时标记输入模态不受支持", async () => {
    create.mockRejectedValueOnce(new FakeApiError(415, "unsupported media type"));
    await expect(requestOpenAiTextResult({
      capability: "media", buildBody: () => BODY, errorLabel: "AI media API", normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: false, mediaFailure: "unsupported" });
  });

  test("普通媒体参数 422 不会被永久误判为能力不支持，也不推动探测退避", async () => {
    create.mockRejectedValueOnce(new FakeApiError(422, "invalid image payload"));
    await expect(requestOpenAiTextResult({
      capability: "media", buildBody: () => BODY, errorLabel: "AI media API", normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: false });
  });

  test("404/405 记成端点配置错误，与「模型不支持这种输入」分开", async () => {
    for (const status of [404, 405]) {
      create.mockRejectedValueOnce(new FakeApiError(status, "model not found"));
      await expect(requestOpenAiTextResult({
        capability: "media", buildBody: () => BODY, errorLabel: "AI media API", normalize: (text: string): string => text,
      })).resolves.toEqual({ ok: false, retryable: false, mediaFailure: "misconfigured" });
    }
  });

  test("端点故障（429/5xx/网络）对 media 归为瞬时，摘要那条不带模态结论", async () => {
    for (const status of [429, 502]) {
      create.mockRejectedValueOnce(new FakeApiError(status, "upstream busy"));
      await expect(requestOpenAiTextResult({
        capability: "media", buildBody: () => BODY, errorLabel: "AI media API", normalize: (text: string): string => text,
      })).resolves.toEqual({ ok: false, retryable: false, mediaFailure: "transient" });
    }
    create.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(requestOpenAiTextResult({
      capability: "media", buildBody: () => BODY, errorLabel: "AI media API", normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: false, mediaFailure: "transient" });

    create.mockRejectedValueOnce(new FakeApiError(502, "upstream busy"));
    await expect(requestOpenAiTextResult({
      capability: "summary", buildBody: () => BODY, errorLabel: "AI test API", normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: false });
  });

  test("请求失败时 retryable=false：SDK 已耗尽 HTTP 重试，不许再套一层", async () => {
    create.mockRejectedValueOnce(new FakeApiError(500, "boom"));
    await expect(requestOpenAiTextResult({
      capability: "summary", buildBody: () => BODY, errorLabel: "AI test API", normalize: (text: string): string => text,
    }))
      .resolves.toEqual({ ok: false, retryable: false });
  });

  test("HTTP 成功但产出异常时 retryable=true：允许业务层重采样", async () => {
    respondWith({ status: "failed", output: [] });
    await expect(requestOpenAiTextResult({
      capability: "summary", buildBody: () => BODY, errorLabel: "AI test API", normalize: (text: string): string => text,
    }))
      .resolves.toEqual({ ok: false, retryable: true });
  });

  test("清洗后正文为空同样允许重采样", async () => {
    respondWith({ output_text: "   " });
    await expect(requestOpenAiTextResult({
      capability: "summary", buildBody: () => BODY, errorLabel: "AI test API", normalize: (text: string): string => text.trim(),
    }))
      .resolves.toEqual({ ok: false, retryable: true });
  });

  test("清洗后仍有正文时按成功返回清洗结果", async () => {
    respondWith({ output_text: "  正文  " });
    await expect(requestOpenAiTextResult({
      capability: "summary", buildBody: () => BODY, errorLabel: "AI test API", normalize: (text: string): string => text.trim(),
    }))
      .resolves.toEqual({ ok: true, text: "正文" });
  });
});
