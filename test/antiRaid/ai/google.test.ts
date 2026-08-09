import { beforeEach, describe, expect, mock, test } from "bun:test";

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
  logger: {
    log(): void {},
    info(): void {},
    warn(): void {},
    error(message: unknown): void { errorLogs.push(String(message)); },
  },
}));

const { requestGoogleAdDetectJson } = await import("../../../packages/antiRaid/ai/google");
const { adDetectGoogleClientHolder } = await import("../../../packages/cache/workers/antiRaid/google");
const {
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

  test("请求错误不叠加业务重试", async () => {
    generateContent.mockImplementation((): never => { throw new FakeApiError("rate limited"); });
    await expect(requestGoogleAdDetectJson(params)).resolves.toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(errorLogs[0]).toBe("Test request failed: 429 rate limited");
  });
});
