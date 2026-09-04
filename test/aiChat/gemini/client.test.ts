import { beforeEach, describe, expect, mock, test } from "bun:test";
import { FinishReason } from "@google/genai";
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAIOptions,
} from "@google/genai";
import { geminiResponse } from "../../helpers/geminiResponse";
import {
  GEMINI_REQUEST_RETRY_ATTEMPTS,
  GEMINI_REQUEST_TIMEOUT_MS,
} from "../../../packages/consts/aiChat/gemini";

const generateContent = mock(async (..._args: GenerateContentParameters[]): Promise<GenerateContentResponse> => geminiResponse({
  candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: [{ text: "ok" }] } }],
}));
const loggerError = mock((..._args: unknown[]): void => {});
const createdClientOptions: GoogleGenAIOptions[] = [];

class FakeApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const googleGenAi = await import("@google/genai");
mock.module("@google/genai", () => ({
  ...googleGenAi,
  ApiError: FakeApiError,
  GoogleGenAI: class {
    constructor(options: GoogleGenAIOptions) {
      createdClientOptions.push(options);
    }
    readonly models = { generateContent };
  },
}));
mock.module("../../../packages/config/agent", () => ({
  getAgentDeploymentConfig: () => ({
    text: { provider: "google", apiKey: "text-key", baseUrl: "https://text.example", model: "text" },
    summary: { provider: "google", apiKey: "summary-key", baseUrl: "https://google.example", model: "summary" },
    media: { provider: "google", apiKey: "media-key", baseUrl: "https://google.example", model: "media" },
    image: { provider: "google", apiKey: "image-key", baseUrl: "https://image.example", model: "image", imageProtocol: undefined },
  }),
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

const {
  requestGeminiResponse,
  requestGeminiResult,
  requestGeminiTextResult,
} = await import("../../../packages/aiChat/gemini/client");
const { geminiClientCache } = await import("../../../packages/cache/workers/aiChat/gemini");

describe("Gemini request safety settings", () => {
  beforeEach(() => {
    geminiClientCache.current = null;
    createdClientOptions.length = 0;
    generateContent.mockClear();
    loggerError.mockClear();
    generateContent.mockImplementation(async (): Promise<GenerateContentResponse> => geminiResponse({
      candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: [{ text: "ok" }] } }],
    }));
  });

  test("所有调用统一关闭四类可调概率拦截，并保留调用方其它 config", async () => {
    expect(GEMINI_REQUEST_RETRY_ATTEMPTS).toBe(6);
    const result = await requestGeminiResponse("summary", (): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
      config: { temperature: 0.7 },
    }), "Gemini test");

    expect(result?.candidates?.[0]?.content?.parts?.[0]?.text).toBe("ok");
    expect(createdClientOptions).toHaveLength(1);
    expect(createdClientOptions[0]?.apiKey).toBe("summary-key");
    expect(createdClientOptions[0]?.httpOptions).toEqual({
      baseUrl: "https://google.example",
      timeout: GEMINI_REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: GEMINI_REQUEST_RETRY_ATTEMPTS },
    });
    const request: GenerateContentParameters = generateContent.mock.calls[0]![0]!;
    expect(request.config?.temperature).toBe(0.7);
    expect(request.config?.safetySettings as unknown).toEqual([
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ]);
  });

  test("systemInstruction 保持在 config 独立字段，不拼入普通对话 contents", async () => {
    await requestGeminiResponse("summary", (): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
      config: { systemInstruction: "系统提示词" },
    }), "Gemini test");

    const request: GenerateContentParameters = generateContent.mock.calls[0]![0]!;
    expect(request.config?.systemInstruction).toBe("系统提示词");
    expect(request.contents).toBe("hello");
  });

  test("SDK API 错误和普通异常都返回 null，并保留可诊断日志", async () => {
    generateContent.mockRejectedValueOnce(new FakeApiError(429, "quota"));
    expect(await requestGeminiResponse("summary", (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }), "Gemini test")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Gemini test error: 429 quota");

    loggerError.mockClear();
    generateContent.mockRejectedValueOnce(new Error("network"));
    expect(await requestGeminiResponse("summary", (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }), "Gemini test")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error calling Gemini test:", expect.any(Error));
  });

  test("安全拦截和 token 截断即使夹带内容也不会越过公共边界", async () => {
    generateContent.mockResolvedValueOnce(geminiResponse({
      candidates: [{ finishReason: FinishReason.MAX_TOKENS, content: { role: "model", parts: [{ text: "partial" }] } }],
      usageMetadata: { thoughtsTokenCount: 12 },
    }));
    const truncated = await requestGeminiResponse("summary", (): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
      config: { maxOutputTokens: 100 },
    }), "Gemini test");
    expect(truncated).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(2);

    loggerError.mockClear();
    generateContent.mockResolvedValueOnce(geminiResponse({ candidates: [{ finishReason: FinishReason.SAFETY }] }));
    expect(await requestGeminiResponse("summary", (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }), "Gemini test")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("finishReason=SAFETY"));
  });

  test("请求体自己抛错也归一成 ok:false，不越过这层边界", async () => {
    // 请求体里要读 config/agent.json 的模型名。这份部署配置写坏时，若请求体是在
    // 调用方的对象字面量里求值，异常就抛在本函数之外：调用方拿不到 ok:false，
    // 异常一路穿过 session.request() 与 generateReply，最终被回复循环最外层的
    // .catch 吞掉——群里看到的是回复连同排队中的其余工具调用一起静默消失。
    const broken = (): GenerateContentParameters => {
      throw new Error("Invalid Gemini config: models.reply must be a non-empty string");
    };

    const result = await requestGeminiResult("summary", broken, "Gemini test");
    expect(result).toMatchObject({ ok: false, failureKind: "request", diagnostic: "request failed" });
    // 请求根本没发出去，配额不该被记账。
    expect(generateContent).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith("Error calling Gemini test:", expect.any(Error));

    // 两个便捷边界同样吃到归一化后的失败，而不是异常。
    expect(await requestGeminiResponse("summary", broken, "Gemini test")).toBeNull();
    await expect(requestGeminiTextResult({
      capability: "summary", buildBody: broken, errorLabel: "Gemini test", normalize: (text: string): string => text,
    }))
      .resolves.toEqual({ ok: false, retryable: false });
  });

  test("判别结果保留未知 finish reason 与 finishMessage 供无副作用降级判断", async () => {
    generateContent.mockResolvedValueOnce(geminiResponse({
      candidates: [{
        finishReason: "TOO_MANY_TOOL_CALLS" as FinishReason,
        finishMessage: "server tool limit",
        content: { parts: [{ text: "不得消费" }, { functionCall: { name: "send_message" } }] },
      }],
    }));
    const result = await requestGeminiResult("summary", (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }), "Gemini test");
    expect(result).toMatchObject({
      ok: false,
      failureKind: "response",
      finishReason: "TOO_MANY_TOOL_CALLS",
      finishMessage: "server tool limit",
    });
  });

  test("文本业务重采样只接受成功请求中的不可用响应", async () => {
    generateContent.mockRejectedValueOnce(new Error("network"));
    await expect(requestGeminiTextResult({
      capability: "summary",
      buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }),
      errorLabel: "Gemini test",
      normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: false });

    generateContent.mockResolvedValueOnce(geminiResponse({
      candidates: [{ finishReason: FinishReason.SAFETY }],
    }));
    await expect(requestGeminiTextResult({
      capability: "summary",
      buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }),
      errorLabel: "Gemini test",
      normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: true });

    generateContent.mockResolvedValueOnce(geminiResponse({
      candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: [{ text: "  " }] } }],
    }));
    await expect(requestGeminiTextResult({
      capability: "summary",
      buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }),
      errorLabel: "Gemini test",
      normalize: (text: string): string => text.trim(),
    })).resolves.toEqual({ ok: false, retryable: true });
  });

  test("media 被确定性 4xx 拒绝时标记输入模态不受支持", async () => {
    generateContent.mockRejectedValueOnce(new FakeApiError(400, "modality unsupported"));
    await expect(requestGeminiTextResult({
      capability: "media",
      buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "media" }),
      errorLabel: "Gemini media",
      normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: false, mediaFailure: "unsupported" });
  });

  test("普通媒体参数 400 不会被永久误判为能力不支持，也不推动探测退避", async () => {
    generateContent.mockRejectedValueOnce(new FakeApiError(400, "invalid image payload"));
    await expect(requestGeminiTextResult({
      capability: "media",
      buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "media" }),
      errorLabel: "Gemini media",
      normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: false });
  });

  test("404/405 记成端点配置错误，与「模型不支持这种输入」分开", async () => {
    for (const status of [404, 405]) {
      generateContent.mockRejectedValueOnce(new FakeApiError(status, "model not found"));
      await expect(requestGeminiTextResult({
        capability: "media",
        buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "media" }),
        errorLabel: "Gemini media",
        normalize: (text: string): string => text,
      })).resolves.toEqual({ ok: false, retryable: false, mediaFailure: "misconfigured" });
    }
  });

  test("端点故障（429/5xx/网络）对 media 归为瞬时，摘要那条不带模态结论", async () => {
    for (const status of [429, 503]) {
      generateContent.mockRejectedValueOnce(new FakeApiError(status, "upstream busy"));
      await expect(requestGeminiTextResult({
        capability: "media",
        buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "media" }),
        errorLabel: "Gemini media",
        normalize: (text: string): string => text,
      })).resolves.toEqual({ ok: false, retryable: false, mediaFailure: "transient" });
    }
    generateContent.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(requestGeminiTextResult({
      capability: "media",
      buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "media" }),
      errorLabel: "Gemini media",
      normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: false, mediaFailure: "transient" });

    // 摘要那条流水线与 media 端点能力无关：一次超时不得推动媒体模态进退避。
    generateContent.mockRejectedValueOnce(new FakeApiError(503, "upstream busy"));
    await expect(requestGeminiTextResult({
      capability: "summary",
      buildBody: (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }),
      errorLabel: "Gemini test",
      normalize: (text: string): string => text,
    })).resolves.toEqual({ ok: false, retryable: false });
  });

  test("SDK 每次尝试各自的 timeout 之外，另有一份覆盖全部重试的 deadline", async () => {
    await requestGeminiResponse("summary", (): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
    }), "Gemini test");

    const request: GenerateContentParameters = generateContent.mock.calls[0]![0]!;
    expect(request.config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(request.config?.abortSignal?.aborted).toBe(false);
  });

  test("请求体携带的 signal 已取消时不调用 SDK", async () => {
    const controller: AbortController = new AbortController();
    controller.abort();

    await expect(requestGeminiResult("summary", (): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
      config: { abortSignal: controller.signal },
    }), "Gemini test")).resolves.toMatchObject({ ok: false, diagnostic: "request aborted" });
    expect(generateContent).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("调用方 invalidate signal 与 deadline 合成后下传，不被替换掉", async () => {
    const controller: AbortController = new AbortController();
    await requestGeminiResponse("summary", (): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
      config: { abortSignal: controller.signal },
    }), "Gemini test");

    const passed: AbortSignal | undefined = generateContent.mock.calls[0]![0]!.config?.abortSignal;
    expect(passed).not.toBe(controller.signal);
    expect(passed?.aborted).toBe(false);
    controller.abort();
    expect(passed?.aborted).toBe(true);
  });

  test("SDK 内部等待不监听 signal 时，invalidate 仍立即结束调用", async () => {
    const controller: AbortController = new AbortController();
    let settleSdkTask!: (value: GenerateContentResponse) => void;
    const sdkTask: Promise<GenerateContentResponse> = new Promise<GenerateContentResponse>((
      resolve: (value: GenerateContentResponse) => void
    ): void => {
      settleSdkTask = resolve;
    });
    generateContent.mockImplementationOnce((): Promise<GenerateContentResponse> => sdkTask);

    const pendingResult: Promise<Awaited<ReturnType<typeof requestGeminiResult>>> =
      requestGeminiResult("summary", (): GenerateContentParameters => ({
        model: "gemini-test",
        contents: "hello",
        config: { abortSignal: controller.signal },
      }), "Gemini test");
    controller.abort();

    await expect(pendingResult).resolves.toMatchObject({
      ok: false,
      failureKind: "request",
      diagnostic: "request aborted",
    });
    expect(loggerError).not.toHaveBeenCalled();
    settleSdkTask(geminiResponse({
      candidates: [{
        finishReason: FinishReason.STOP,
        content: { role: "model", parts: [{ text: "late" }] },
      }],
    }));
    await sdkTask;
  });
});
