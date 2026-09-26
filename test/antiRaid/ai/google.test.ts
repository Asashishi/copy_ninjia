import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";

const errorLogs: string[] = [];
const constructions: unknown[] = [];
const generateContent = mock(async (..._args: unknown[]): Promise<unknown> => ({
  candidates: [{ finishReason: "STOP" }],
  text: "{\"ad\":false,\"reason\":\"闲聊\"}",
}));

class FakeApiError extends Error {
  status: number = 429;
}

mock.module("@google/genai", () => ({
  ApiError: FakeApiError,
  FinishReason: { STOP: "STOP" },
  GoogleGenAI: class FakeGoogleGenAI {
    models: { generateContent: typeof generateContent } = { generateContent };
    constructor(options: unknown) { constructions.push(options); }
  },
}));
mock.module("../../../packages/config/agent", () => ({
  getAdDetectAgentConfig: () => ({
    provider: "google",
    apiKey: "google-ad-key",
    baseUrl: "https://google.example",
    model: "gemini-ad",
  }),
}));
mock.module("../../../packages/infra/logger", () => ({
  logger: loggerStub({ error(message: unknown): void { errorLogs.push(String(message)); } }),
}));

const { requestGoogleAdDetectJson } = await import("../../../packages/antiRaid/ai/google");
const { adDetectGoogleClientHolder } = await import("../../../packages/cache/workers/antiRaid/google");
const { installAiCacheUsageSink } = await import("../../../packages/infra/aiCacheUsage");
import type { AiCacheUsage } from "../../../packages/types/aiCache";
const {
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
} = await import("../../../packages/consts/antiRaid/adDetect");

const params = {
  model: "gemini-ad",
  systemPrompt: "只输出 JSON",
  userContent: "1. 在吗",
  temperature: 0.5,
  maxOutputTokens: 256,
  errorLabel: "Test request",
};

beforeEach((): void => {
  adDetectGoogleClientHolder.current = null;
  constructions.length = 0;
  errorLogs.length = 0;
  generateContent.mockClear();
  generateContent.mockImplementation(async (): Promise<unknown> => ({
    candidates: [{ finishReason: "STOP" }],
    text: "{\"ad\":false,\"reason\":\"闲聊\"}",
  }));
});

describe("Google 广告检测请求入口", () => {
  test("使用独立凭据、端点与结构化 JSON 请求", async () => {
    await expect(requestGoogleAdDetectJson(params)).resolves.toContain("闲聊");
    expect(constructions[0]).toEqual({
      apiKey: "google-ad-key",
      httpOptions: {
        baseUrl: "https://google.example",
        timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
        retryOptions: { attempts: AD_DETECT_GOOGLE_REQUEST_ATTEMPTS },
      },
    });
    expect(generateContent.mock.calls[0]?.[0]).toMatchObject({
      model: "gemini-ad",
      contents: [{ role: "user", parts: [{ text: "1. 在吗" }] }],
      config: {
        systemInstruction: "只输出 JSON",
        responseMimeType: "application/json",
      },
    });
    const request = generateContent.mock.calls[0]?.[0] as { config?: { temperature?: number } };
    expect(request.config?.temperature).toBeUndefined();
  });

  test("成功响应按 ad_detect 上报 Gemini 用量", async () => {
    const reported: AiCacheUsage[] = [];
    installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
    generateContent.mockImplementationOnce(async (): Promise<unknown> => ({
      candidates: [{ finishReason: "STOP" }],
      text: "{\"ad\":false,\"reason\":\"闲聊\"}",
      usageMetadata: { promptTokenCount: 700, cachedContentTokenCount: 512, candidatesTokenCount: 9 },
    }));
    try {
      await requestGoogleAdDetectJson(params);
    } finally {
      installAiCacheUsageSink(null);
    }
    expect(reported.map(({ timestamp: _timestamp, ...rest }: AiCacheUsage) => rest)).toEqual([
      { capability: "ad_detect", provider: "google", model: "gemini-ad", inputTokens: 700, cachedInputTokens: 512, outputTokens: 9 },
    ]);
  });

  test("请求错误不叠加业务重试", async () => {
    generateContent.mockImplementation((): never => { throw new FakeApiError("rate limited"); });
    await expect(requestGoogleAdDetectJson(params)).resolves.toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(errorLogs[0]).toBe("Test request failed: 429 rate limited");
  });

  test("非 STOP 结束或空正文有限重试，耗尽后记一条错误并返回 null", async () => {
    generateContent.mockImplementation(async (): Promise<unknown> => ({
      candidates: [{ finishReason: "MAX_TOKENS" }],
      text: "{\"ad\":",
    }));
    await expect(requestGoogleAdDetectJson(params)).resolves.toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS);
    expect(errorLogs).toEqual([
      `Test request returned no usable body in ${AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS} attempt(s).`,
    ]);
  });

  test("空白正文按不可用处理，下一次拿到正文即返回", async () => {
    generateContent
      .mockImplementationOnce(async (): Promise<unknown> => ({ candidates: [{ finishReason: "STOP" }], text: "   " }))
      .mockImplementationOnce(async (): Promise<unknown> => ({ candidates: [{ finishReason: "STOP" }], text: " {\"ad\":true,\"reason\":\"引流\"} " }));
    await expect(requestGoogleAdDetectJson(params)).resolves.toBe("{\"ad\":true,\"reason\":\"引流\"}");
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(errorLogs).toEqual([]);
  });
});
