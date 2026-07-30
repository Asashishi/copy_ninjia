import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";

const generateContent = mock(async (..._args: GenerateContentParameters[]): Promise<GenerateContentResponse> => ({
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "ok" }] } }],
} as unknown as GenerateContentResponse));
const loggerError = mock((..._args: unknown[]): void => {});

class FakeApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

mock.module("@google/genai", () => ({
  ApiError: FakeApiError,
  GoogleGenAI: class {
    readonly models = { generateContent };
  },
  HarmBlockThreshold: { BLOCK_NONE: "BLOCK_NONE" },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
  },
}));
mock.module("../../../packages/infra/config", () => ({ AI_CHAT_GEMINI_API_KEY: "test-key" }));
mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

const { requestGeminiResponse, requestGeminiResult } = await import("../../../packages/aiChat/ai/gemini");

describe("Gemini request safety settings", () => {
  beforeEach(() => {
    generateContent.mockClear();
    loggerError.mockClear();
    generateContent.mockImplementation(async (): Promise<GenerateContentResponse> => ({
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "ok" }] } }],
    } as unknown as GenerateContentResponse));
  });

  test("所有调用统一关闭四类可调概率拦截，并保留调用方其它 config", async () => {
    const result = await requestGeminiResponse({
      model: "gemini-test",
      contents: "hello",
      config: { temperature: 0.7 },
    }, "Gemini test");

    expect(result?.candidates?.[0]?.content?.parts?.[0]?.text).toBe("ok");
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
    await requestGeminiResponse({
      model: "gemini-test",
      contents: "hello",
      config: { systemInstruction: "系统提示词" },
    }, "Gemini test");

    const request: GenerateContentParameters = generateContent.mock.calls[0]![0]!;
    expect(request.config?.systemInstruction).toBe("系统提示词");
    expect(request.contents).toBe("hello");
  });

  test("SDK API 错误和普通异常都返回 null，并保留可诊断日志", async () => {
    generateContent.mockRejectedValueOnce(new FakeApiError(429, "quota"));
    expect(await requestGeminiResponse({ model: "gemini-test", contents: "hello" }, "Gemini test")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Gemini test error: 429 quota");

    loggerError.mockClear();
    generateContent.mockRejectedValueOnce(new Error("network"));
    expect(await requestGeminiResponse({ model: "gemini-test", contents: "hello" }, "Gemini test")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error calling Gemini test:", expect.any(Error));
  });

  test("安全拦截和 token 截断即使夹带内容也不会越过公共边界", async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ finishReason: "MAX_TOKENS", content: { role: "model", parts: [{ text: "partial" }] } }],
      usageMetadata: { thoughtsTokenCount: 12 },
    } as unknown as GenerateContentResponse);
    const truncated = await requestGeminiResponse({
      model: "gemini-test",
      contents: "hello",
      config: { maxOutputTokens: 100 },
    }, "Gemini test");
    expect(truncated).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(2);

    loggerError.mockClear();
    generateContent.mockResolvedValueOnce({ candidates: [{ finishReason: "SAFETY" }] } as unknown as GenerateContentResponse);
    expect(await requestGeminiResponse({ model: "gemini-test", contents: "hello" }, "Gemini test")).toBeNull();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("finishReason=SAFETY"));
  });

  test("判别结果保留未知 finish reason 与 finishMessage 供无副作用降级判断", async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{
        finishReason: "TOO_MANY_TOOL_CALLS",
        finishMessage: "server tool limit",
        content: { parts: [{ text: "不得消费" }, { functionCall: { name: "send_message" } }] },
      }],
    } as unknown as GenerateContentResponse);
    const result = await requestGeminiResult({ model: "gemini-test", contents: "hello" }, "Gemini test");
    expect(result).toMatchObject({
      ok: false,
      finishReason: "TOO_MANY_TOOL_CALLS",
      finishMessage: "server tool limit",
    });
  });
});
