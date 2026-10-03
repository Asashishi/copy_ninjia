import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { waitUntil } from "../../helpers/waitUntil";
import type { AdDetectJsonRequestParams } from "../../../packages/types/antiRaid/adDetect";
import type { GeminiContextCacheRegistry } from "../../../packages/types/geminiContextCache";

const errorLogs: string[] = [];
const constructions: unknown[] = [];
const generateContent = mock(async (..._args: unknown[]): Promise<unknown> => ({
  candidates: [{ finishReason: "STOP" }],
  text: "{\"ad\":false,\"reason\":\"闲聊\"}",
}));

interface FakeCache {
  readonly name?: string;
  readonly displayName?: string;
  readonly expireTime?: string;
}

let createdCount: number = 0;
/** caches.create 的入参里本测试关心的字段。 */
interface FakeCreateParams {
  readonly config: { readonly displayName: string; readonly ttl: string; readonly abortSignal?: AbortSignal };
}

const cacheCreate = mock(async (params: FakeCreateParams): Promise<FakeCache> => {
  createdCount += 1;
  return {
    name: `cachedContents/ad-${createdCount}`,
    displayName: params.config.displayName,
    expireTime: new Date(Date.now() + Number.parseInt(params.config.ttl, 10) * 1_000).toISOString(),
  };
});
const cacheDelete = mock(async (..._args: unknown[]): Promise<object> => ({}));
const cacheUpdate = mock(async (..._args: unknown[]): Promise<FakeCache> => ({}));
const cacheList = mock(async (..._args: unknown[]): Promise<AsyncIterable<FakeCache>> => ({
  async *[Symbol.asyncIterator](): AsyncGenerator<FakeCache> {},
}));

class FakeApiError extends Error {
  status: number = 429;
  constructor(message: string, status: number = 429) {
    super(message);
    this.status = status;
  }
}

mock.module("@google/genai", () => ({
  ApiError: FakeApiError,
  FinishReason: { STOP: "STOP" },
  GoogleGenAI: class FakeGoogleGenAI {
    models: { generateContent: typeof generateContent } = { generateContent };
    caches: object = { create: cacheCreate, delete: cacheDelete, update: cacheUpdate, list: cacheList };
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

const { AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE, requestGoogleAdDetectJson } = await import("../../../packages/workers/antiRaid/adDetect/ai/google");
const { adDetectGoogleClientHolder } = await import("../../../packages/cache/workers/antiRaid/google");
const {
  adDetectGeminiCacheContent,
  adDetectGeminiContextCache,
} = await import("../../../packages/cache/workers/antiRaid/geminiContextCache");
const { installAiCacheUsageSink } = await import("../../../packages/infra/aiCacheUsage");
const { quiesceAntiRaidDispatch } = await import("../../../packages/workers/antiRaid/taskTracker");
const { antiRaidDispatchAbort } = await import("../../../packages/cache/workers/antiRaid/tasks");
const { GEMINI_CONTEXT_CACHE_TTL_SECONDS } = await import("../../../packages/consts/geminiContextCache");
import type { AiCacheUsage } from "../../../packages/types/aiCache";
const {
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
  AD_DETECT_GEMINI_CACHE_DISPLAY_NAME_PREFIX,
  AD_DETECT_GEMINI_CACHE_MAX_SLOTS,
  AD_DETECT_GOOGLE_REQUEST_ATTEMPTS,
  AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
} = await import("../../../packages/consts/antiRaid/adDetect");

const params: AdDetectJsonRequestParams = {
  model: "gemini-ad",
  instructions: "规则与示例",
  fact: "【系统事实】夹具事实",
  systemPrompt: "规则与示例\n【系统事实】夹具事实",
  userContent: "1. 在吗",
  temperature: 0.5,
  maxOutputTokens: 256,
  errorLabel: "Test request",
};

/** 一次 generateContent 请求体里本测试关心的字段。 */
interface SentRequest {
  readonly model: string;
  readonly contents: unknown;
  readonly config: {
    readonly cachedContent?: string;
    readonly systemInstruction?: string;
    readonly temperature?: number;
    readonly responseMimeType?: string;
    readonly responseJsonSchema?: unknown;
    readonly maxOutputTokens?: number;
  };
}

function sentAt(index: number): SentRequest {
  return generateContent.mock.calls[index]![0] as SentRequest;
}

function registry(): GeminiContextCacheRegistry {
  return adDetectGeminiContextCache.current!;
}

/** 跑完启动扫描与一次后台创建，之后的判定引用显式缓存。 */
async function warmCache(request: AdDetectJsonRequestParams = params): Promise<void> {
  await requestGoogleAdDetectJson(request);
  expect(await waitUntil((): boolean => registry().scan === "done")).toBe(true);
  await requestGoogleAdDetectJson(request);
  await Promise.allSettled([...registry().creations.values()]);
  await Bun.sleep(0);
}

beforeEach((): void => {
  adDetectGoogleClientHolder.current = null;
  adDetectGeminiContextCache.current = null;
  adDetectGeminiCacheContent.current = null;
  antiRaidDispatchAbort.current = null;
  constructions.length = 0;
  errorLogs.length = 0;
  createdCount = 0;
  for (const fn of [generateContent, cacheCreate, cacheDelete, cacheUpdate, cacheList]) fn.mockClear();
  generateContent.mockImplementation(async (): Promise<unknown> => ({
    candidates: [{ finishReason: "STOP" }],
    text: "{\"ad\":false,\"reason\":\"闲聊\"}",
  }));
});

describe("Google 广告检测请求入口", () => {
  test("使用独立凭据、端点与结构化 JSON 请求；系统事实作为正文之前的独立 part", async () => {
    await expect(requestGoogleAdDetectJson(params)).resolves.toContain("闲聊");
    expect(constructions[0]).toEqual({
      apiKey: "google-ad-key",
      httpOptions: {
        baseUrl: "https://google.example",
        timeout: AD_DETECT_GOOGLE_REQUEST_TIMEOUT_MS,
        retryOptions: { attempts: AD_DETECT_GOOGLE_REQUEST_ATTEMPTS },
      },
    });
    expect(sentAt(0)).toMatchObject({
      model: "gemini-ad",
      contents: [{ role: "user", parts: [{ text: params.fact }, { text: params.userContent }] }],
      config: {
        systemInstruction: params.instructions,
        responseMimeType: "application/json",
        maxOutputTokens: params.maxOutputTokens,
      },
    });
    expect(sentAt(0).config.cachedContent).toBeUndefined();
    expect(sentAt(0).config.temperature).toBeUndefined();
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
      { kind: "tokens", capability: "ad_detect", provider: "google", model: "gemini-ad", inputTokens: 700, cachedInputTokens: 512, outputTokens: 9 },
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

describe("ad_detect 显式缓存", () => {
  test("缓存只装规则与示例段；建成后引用 cachedContent、不带系统指令，contents 与不带缓存时逐字一致", async () => {
    await warmCache();

    expect(cacheCreate).toHaveBeenCalledTimes(1);
    const created = cacheCreate.mock.calls[0]![0] as unknown as { model: string; config: Record<string, unknown> };
    expect(created.model).toBe(params.model);
    expect(created.config.systemInstruction).toBe(params.instructions);
    expect(created.config.ttl).toBe(`${GEMINI_CONTEXT_CACHE_TTL_SECONDS}s`);
    expect(created.config.tools).toBeUndefined();
    expect(created.config.toolConfig).toBeUndefined();
    expect(String(created.config.displayName).startsWith(AD_DETECT_GEMINI_CACHE_DISPLAY_NAME_PREFIX)).toBe(true);

    await requestGoogleAdDetectJson(params);
    const uncached: SentRequest = sentAt(0);
    const cached: SentRequest = sentAt(2);
    expect(cached.config.cachedContent).toBe("cachedContents/ad-1");
    expect(cached.config.systemInstruction).toBeUndefined();
    expect(cached.config.responseMimeType).toBe("application/json");
    expect(cached.config.responseJsonSchema).toEqual(uncached.config.responseJsonSchema);
    expect(cached.contents).toEqual(uncached.contents);
    expect(cached.contents).toEqual([{ role: "user", parts: [{ text: params.fact }, { text: params.userContent }] }]);
  });

  test("两个系统事实变体共用同一个槽", async () => {
    await warmCache();
    await requestGoogleAdDetectJson({ ...params, fact: "【系统事实】另一侧", systemPrompt: "规则与示例\n【系统事实】另一侧" });
    const last: SentRequest = sentAt(generateContent.mock.calls.length - 1);
    expect(last.config.cachedContent).toBe("cachedContents/ad-1");
    expect(cacheCreate).toHaveBeenCalledTimes(1);
    expect(registry().slots.size).toBe(1);
  });

  test("指纹随规则与示例段缓存：模型与系统指令不变时每次判定复用同一份", async () => {
    await requestGoogleAdDetectJson(params);
    const memo = adDetectGeminiCacheContent.current;
    expect(memo).not.toBeNull();
    await requestGoogleAdDetectJson({ ...params, userContent: "2. 另一串" });
    expect(adDetectGeminiCacheContent.current).toBe(memo);

    await requestGoogleAdDetectJson({ ...params, instructions: "新的规则与示例" });
    expect(adDetectGeminiCacheContent.current).not.toBe(memo);
    expect(adDetectGeminiCacheContent.current!.systemInstruction).toBe("新的规则与示例");
  });

  test("缓存被端点拒绝时释放登记，当场用完整请求补发一次", async () => {
    await warmCache();
    generateContent.mockImplementationOnce((): never => { throw new FakeApiError("cache not found", 403); });

    await expect(requestGoogleAdDetectJson(params)).resolves.toContain("闲聊");
    const calls: number = generateContent.mock.calls.length;
    expect(sentAt(calls - 2).config.cachedContent).toBe("cachedContents/ad-1");
    const resent: SentRequest = sentAt(calls - 1);
    expect(resent.config.cachedContent).toBeUndefined();
    expect(resent.config.systemInstruction).toBe(params.instructions);
    expect(resent.contents).toEqual(sentAt(calls - 2).contents);
    expect(registry().slots.size).toBe(0);
    expect(cacheDelete).toHaveBeenCalledWith(expect.objectContaining({ name: "cachedContents/ad-1" }));
    expect(errorLogs).toEqual(["Test request failed: 403 cache not found"]);
  });

  test("端点故障不补发，也不释放登记", async () => {
    await warmCache();
    generateContent.mockImplementationOnce((): never => { throw new FakeApiError("unavailable", 503); });
    const before: number = generateContent.mock.calls.length;

    await expect(requestGoogleAdDetectJson(params)).resolves.toBeNull();
    expect(generateContent.mock.calls.length - before).toBe(1);
    expect(registry().slots.size).toBe(1);
  });

  test("示例换了走新槽；超过槽数上限时回收最久未用的旧槽", async () => {
    await warmCache();
    for (let version: number = 1; version <= AD_DETECT_GEMINI_CACHE_MAX_SLOTS; version++) {
      await Bun.sleep(2);
      await warmCache({ ...params, instructions: `规则与示例 v${version}` });
    }
    expect(cacheCreate).toHaveBeenCalledTimes(AD_DETECT_GEMINI_CACHE_MAX_SLOTS + 1);
    expect(registry().slots.size).toBe(AD_DETECT_GEMINI_CACHE_MAX_SLOTS);
    expect(cacheDelete).toHaveBeenCalledWith(expect.objectContaining({ name: "cachedContents/ad-1" }));
  });

  test("scope 的后台请求使用 Anti-Raid 派发信号，停机后随之取消", async () => {
    expect(AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE.signal().aborted).toBe(false);
    await requestGoogleAdDetectJson(params);
    expect(await waitUntil((): boolean => registry().scan === "done")).toBe(true);

    cacheCreate.mockImplementationOnce(async (created: FakeCreateParams): Promise<FakeCache> => {
      quiesceAntiRaidDispatch();
      expect(created.config.abortSignal?.aborted).toBe(true);
      throw created.config.abortSignal?.reason;
    });
    await requestGoogleAdDetectJson(params);
    await Promise.allSettled([...registry().creations.values()]);
    await Bun.sleep(0);
    expect(AD_DETECT_GEMINI_CONTEXT_CACHE_SCOPE.signal().aborted).toBe(true);
    expect(registry().failures.size).toBe(0);
    expect(errorLogs).toEqual([]);
  });
});
