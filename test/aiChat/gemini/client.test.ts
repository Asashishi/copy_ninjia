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
mock.module("../../../packages/infra/config", () => ({ AI_CHAT_GEMINI_API_KEY: "test-key" }));
mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

const {
  requestGeminiResponse,
  requestGeminiResult,
  requestGeminiTextResult,
} = await import("../../../packages/aiChat/gemini/client");

describe("Gemini request safety settings", () => {
  beforeEach(() => {
    generateContent.mockClear();
    loggerError.mockClear();
    generateContent.mockImplementation(async (): Promise<GenerateContentResponse> => geminiResponse({
      candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: [{ text: "ok" }] } }],
    }));
  });

  test("所有调用统一关闭四类可调概率拦截，并保留调用方其它 config", async () => {
    const result = await requestGeminiResponse((): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
      config: { temperature: 0.7 },
    }), "Gemini test");

    expect(result?.candidates?.[0]?.content?.parts?.[0]?.text).toBe("ok");
    expect(createdClientOptions).toHaveLength(1);
    expect(createdClientOptions[0]?.httpOptions).toEqual({
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
    await requestGeminiResponse((): GenerateContentParameters => ({
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
    expect(await requestGeminiResponse((): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }), "Gemini test")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Gemini test error: 429 quota");

    loggerError.mockClear();
    generateContent.mockRejectedValueOnce(new Error("network"));
    expect(await requestGeminiResponse((): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }), "Gemini test")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error calling Gemini test:", expect.any(Error));
  });

  test("安全拦截和 token 截断即使夹带内容也不会越过公共边界", async () => {
    generateContent.mockResolvedValueOnce(geminiResponse({
      candidates: [{ finishReason: FinishReason.MAX_TOKENS, content: { role: "model", parts: [{ text: "partial" }] } }],
      usageMetadata: { thoughtsTokenCount: 12 },
    }));
    const truncated = await requestGeminiResponse((): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
      config: { maxOutputTokens: 100 },
    }), "Gemini test");
    expect(truncated).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(2);

    loggerError.mockClear();
    generateContent.mockResolvedValueOnce(geminiResponse({ candidates: [{ finishReason: FinishReason.SAFETY }] }));
    expect(await requestGeminiResponse((): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }), "Gemini test")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("finishReason=SAFETY"));
  });

  test("请求体自己抛错也归一成 ok:false，不越过这层边界", async () => {
    // 请求体里要读 config/gemini.json 的模型名。这份部署配置写坏时，若请求体是在
    // 调用方的对象字面量里求值，异常就抛在本函数之外：调用方拿不到 ok:false，
    // 异常一路穿过 session.request() 与 generateReply，最终被回复循环最外层的
    // .catch 吞掉——群里看到的是回复连同排队中的其余工具调用一起静默消失。
    const broken = (): GenerateContentParameters => {
      throw new Error("Invalid Gemini config: models.reply must be a non-empty string");
    };

    const result = await requestGeminiResult(broken, "Gemini test");
    expect(result).toMatchObject({ ok: false, failureKind: "request", diagnostic: "request failed" });
    // 请求根本没发出去，配额不该被记账。
    expect(generateContent).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith("Error calling Gemini test:", expect.any(Error));

    // 两个便捷边界同样吃到归一化后的失败，而不是异常。
    expect(await requestGeminiResponse(broken, "Gemini test")).toBeNull();
    await expect(requestGeminiTextResult(broken, "Gemini test", (text: string): string => text))
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
    const result = await requestGeminiResult((): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }), "Gemini test");
    expect(result).toMatchObject({
      ok: false,
      failureKind: "response",
      finishReason: "TOO_MANY_TOOL_CALLS",
      finishMessage: "server tool limit",
    });
  });

  test("文本业务重采样只接受成功请求中的不可用响应", async () => {
    generateContent.mockRejectedValueOnce(new Error("network"));
    await expect(requestGeminiTextResult(
      (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }),
      "Gemini test",
      (text: string): string => text
    )).resolves.toEqual({ ok: false, retryable: false });

    generateContent.mockResolvedValueOnce(geminiResponse({
      candidates: [{ finishReason: FinishReason.SAFETY }],
    }));
    await expect(requestGeminiTextResult(
      (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }),
      "Gemini test",
      (text: string): string => text
    )).resolves.toEqual({ ok: false, retryable: true });

    generateContent.mockResolvedValueOnce(geminiResponse({
      candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: [{ text: "  " }] } }],
    }));
    await expect(requestGeminiTextResult(
      (): GenerateContentParameters => ({ model: "gemini-test", contents: "hello" }),
      "Gemini test",
      (text: string): string => text.trim()
    )).resolves.toEqual({ ok: false, retryable: true });
  });
});
