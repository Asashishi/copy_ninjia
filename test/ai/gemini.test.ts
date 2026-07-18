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
  HarmBlockThreshold: { BLOCK_ONLY_HIGH: "BLOCK_ONLY_HIGH" },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
  },
}));
mock.module("../../src/infra/config", () => ({ GEMINI_API_KEY: "test-key" }));
mock.module("../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error: loggerError },
}));

const { requestGeminiResponse } = await import("../../src/ai/gemini");

describe("Gemini request safety settings", () => {
  beforeEach(() => {
    generateContent.mockClear();
    loggerError.mockClear();
    generateContent.mockImplementation(async (): Promise<GenerateContentResponse> => ({
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "ok" }] } }],
    } as unknown as GenerateContentResponse));
  });

  test("所有调用统一为四类仅高概率拦截，并保留调用方其它 config", async () => {
    const result = await requestGeminiResponse({
      model: "gemini-test",
      contents: "hello",
      config: { temperature: 0.7 },
    }, "Gemini test");

    expect(result?.candidates?.[0]?.content?.parts?.[0]?.text).toBe("ok");
    const request: GenerateContentParameters = generateContent.mock.calls[0]![0]!;
    expect(request.config?.temperature).toBe(0.7);
    expect(request.config?.safetySettings as unknown).toEqual([
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ]);
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

  test("安全拦截和 token 截断的成功响应仍保留原响应，同时记录不可用原因", async () => {
    generateContent.mockResolvedValueOnce({
      candidates: [{ finishReason: "MAX_TOKENS", content: { role: "model", parts: [{ text: "partial" }] } }],
      usageMetadata: { thoughtsTokenCount: 12 },
    } as unknown as GenerateContentResponse);
    const truncated = await requestGeminiResponse({
      model: "gemini-test",
      contents: "hello",
      config: { maxOutputTokens: 100 },
    }, "Gemini test");
    expect(String(truncated?.candidates?.[0]?.finishReason)).toBe("MAX_TOKENS");
    expect(loggerError).toHaveBeenCalledTimes(1);

    loggerError.mockClear();
    generateContent.mockResolvedValueOnce({ candidates: [{ finishReason: "SAFETY" }] } as unknown as GenerateContentResponse);
    expect(await requestGeminiResponse({ model: "gemini-test", contents: "hello" }, "Gemini test")).not.toBeNull();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("finishReason=SAFETY"));
  });
});
