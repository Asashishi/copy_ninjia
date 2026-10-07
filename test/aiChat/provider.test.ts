import { TTS_DEFAULT_BOT_LANGUAGE, TTS_DEFAULT_STYLE } from "../../packages/consts/aiChat/voiceMessage";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { TtsDailyUsage } from "../../packages/types/aiChat/voiceMessage";
import { loggerStub } from "../helpers/loggerMock";
import type { GoogleGenAI } from "@google/genai";
import type { AgentDeploymentConfig } from "../../packages/types/config";
import type { GeminiContextCacheRegistry } from "../../packages/types/geminiContextCache";
import { SEND_VOICE_TOOL } from "../../packages/consts/tools";

let agentConfig: AgentDeploymentConfig;
mock.module("../../packages/config/agent", () => ({
  getAgentDeploymentConfig: (): AgentDeploymentConfig => agentConfig,
  adoptAgentDeploymentConfig: (config: AgentDeploymentConfig): void => {
    agentConfig = config;
  },
}));
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });
const loggerError = mock((..._args: unknown[]): void => {});
const loggerWarn = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerError, warn: loggerWarn }),
}));

const {
  imageAiProvider,
  mediaAiProvider,
  reloadAgentDeploymentConfig,
  reportUnimplementedAgentCapabilities,
  summaryAiProvider,
  textAiProvider,
  structuredTextAiProvider,
  textWebSearchAiProvider,
  ttsAiProvider,
  webSearchAiProvider,
} = await import("../../packages/aiChat/provider");
const { geminiClientCache } = await import("../../packages/cache/workers/aiChat/gemini");
const { textGeminiContextCache } = await import("../../packages/cache/workers/aiChat/geminiContextCache");
const { createGeminiContextCacheRegistry } = await import("../../packages/infra/geminiContextCache");
const { ttsDailyUsage } = await import("../../packages/cache/workers/aiChat/ttsUsage");
const { openAiClientCache } = await import("../../packages/cache/workers/aiChat/openai");
const {
  getMediaInputState,
  mediaInputSupportCache,
  recordMediaInputResult,
} = await import("../../packages/cache/workers/aiChat/mediaInputSupport");
const { geminiProvider } = await import("../../packages/aiChat/gemini");
const { openAiProvider } = await import("../../packages/aiChat/openai");
const { anthropicProvider } = await import("../../packages/aiChat/anthropic");
const { aiProviderQuotaLanes, resetAiProviderSchedulerCache } =
  await import("../../packages/cache/workers/aiChat/providerScheduler");
const {
  AI_PROVIDER_BACKGROUND_MAX_PENDING,
  AI_PROVIDER_MAX_CONCURRENT,
} = await import("../../packages/consts/aiChat/provider");

beforeEach((): void => {
  resetAiProviderSchedulerCache();
  mediaInputSupportCache.current = null;
  geminiClientCache.current = null;
  openAiClientCache.current = null;
  agentConfig = {
    text: { provider: "google", apiKey: "google-text-key", baseUrl: undefined, headers: undefined, model: "gemini-text" },
    summary: { provider: "openai", apiKey: "openai-summary-key", baseUrl: "https://openai.example/v1", headers: undefined, model: "gpt-summary" },
    media: { provider: "google", apiKey: "google-media-key", baseUrl: "https://google.example", headers: undefined, model: "gemini-media" },
    image: {
      provider: "openai",
      apiKey: "xai-image-key",
      baseUrl: "https://xai.example/v1",
      headers: undefined,
      model: "grok-image",
      imageProtocol: "xai",
    },
    tts: { provider: "google", apiKey: "google-tts-key", baseUrl: undefined, headers: undefined, model: "tts-model", voice: "Leda", speechProtocol: undefined, style: TTS_DEFAULT_STYLE, language: undefined, botLanguage: TTS_DEFAULT_BOT_LANGUAGE, dailyLimit: 100, dailyReserveQuota: 25 },
  };
  loggerError.mockClear();
  loggerWarn.mockClear();
});

test("每项能力按 agent 配置独立选择 provider", () => {
  expect(textAiProvider().name).toBe("google");
  expect(summaryAiProvider().name).toBe("openai");
  expect(mediaAiProvider().name).toBe("google");
  expect(imageAiProvider()?.name).toBe("openai");
  expect(ttsAiProvider()?.name).toBe("google");
});

test("修改一项只影响该能力", () => {
  agentConfig = {
    ...agentConfig,
    media: { provider: "openai", apiKey: "openai-media-key", baseUrl: undefined, headers: undefined, model: "vision-model" },
  };
  expect(mediaAiProvider().name).toBe("openai");
  expect(textAiProvider().name).toBe("google");
  expect(summaryAiProvider().name).toBe("openai");
});

test("tts 缺省时明确不提供语音合成实现", () => {
  const { tts: _tts, ...withoutTts } = agentConfig;
  agentConfig = withoutTts;
  expect(ttsAiProvider()).toBeNull();
});

test("image 缺省时明确不提供生图实现", () => {
  const { image: _image, ...withoutImage } = agentConfig;
  agentConfig = withoutImage;
  expect(imageAiProvider()).toBeNull();
});

test("image 选中的实现缺席 generateImage 时没有生图门面", () => {
  // Anthropic 实现不提供生图；配置类型不允许这样选，这里绕过类型直接走路由。
  agentConfig = { ...agentConfig, image: { ...agentConfig.image!, provider: "anthropic" } } as unknown as AgentDeploymentConfig;
  expect(imageAiProvider()).toBeNull();
});

test("Google 与 OpenAI 装配齐对话、摘要、媒体、生图、检索与 JSON 能力", () => {
  for (const provider of [geminiProvider, openAiProvider] as const) {
    expect(typeof provider.createReplySession).toBe("function");
    expect(typeof provider.generateText).toBe("function");
    expect(typeof provider.describeVision).toBe("function");
    expect(typeof provider.generateImage).toBe("function");
    expect(typeof provider.searchWeb).toBe("function");
    expect(typeof provider.generateJson).toBe("function");
  }
});

test("web_search 缺省时明确不提供检索执行器；配置时按它自己的 provider 路由，并按端点与凭据归入配额 lane", async () => {
  expect(webSearchAiProvider()).toBeNull();
  agentConfig = {
    ...agentConfig,
    webSearch: { provider: "openai", apiKey: "openai-summary-key", baseUrl: "https://openai.example/v1", headers: undefined, model: "gpt-search", maxCallsPerUse: 7 },
  };
  resetAiProviderSchedulerCache();
  summaryAiProvider();
  const lanes: number = aiProviderQuotaLanes.length;
  const searchWeb = spyOn(openAiProvider, "searchWeb")
    .mockImplementation(async () => ({ ok: true, text: "结论", sources: [], searchCalls: 1 }));
  try {
    expect(webSearchAiProvider()?.name).toBe("openai");
    expect(webSearchAiProvider()).toBe(webSearchAiProvider());
    expect(aiProviderQuotaLanes).toHaveLength(lanes);
    await expect(webSearchAiProvider()?.searchWeb({ instruction: "i", query: "q" }))
      .resolves.toEqual({ ok: true, text: "结论", sources: [], searchCalls: 1 });
    expect(searchWeb).toHaveBeenCalledTimes(1);
  } finally {
    searchWeb.mockRestore();
  }
});

test("cron 摘要的 text 检索与结构化 JSON 门面都按 text 配置路由，检索把绑定的能力名交给实现", async () => {
  const searchWeb = spyOn(geminiProvider, "searchWeb")
    .mockImplementation(async () => ({ ok: true, text: "要点", sources: [], searchCalls: 1 }));
  const generateJson = spyOn(geminiProvider, "generateJson")
    .mockImplementation(async () => ({ ok: true, text: "{}" }));
  try {
    expect(textWebSearchAiProvider().name).toBe("google");
    expect(textWebSearchAiProvider()).toBe(textWebSearchAiProvider());
    await textWebSearchAiProvider().searchWeb({ instruction: "i", query: "q" });
    expect(searchWeb).toHaveBeenCalledWith("text", { instruction: "i", query: "q" });
    expect(structuredTextAiProvider()).toBe(structuredTextAiProvider());
    await expect(structuredTextAiProvider().generateJson({ systemPrompt: "s", userContent: "u", jsonSchema: {}, errorLabel: "e" }))
      .resolves.toEqual({ ok: true, text: "{}" });
  } finally {
    searchWeb.mockRestore();
    generateJson.mockRestore();
  }
});

test("检索门面排队期间被取消时按一次都没检索的失败结算，不发起请求", async () => {
  agentConfig = {
    ...agentConfig,
    webSearch: { provider: "google", apiKey: "google-text-key", baseUrl: undefined, headers: undefined, model: "gemini-search", maxCallsPerUse: 7 },
  };
  const searchWeb = spyOn(geminiProvider, "searchWeb");
  try {
    const aborted: AbortController = new AbortController();
    aborted.abort();
    await expect(webSearchAiProvider()?.searchWeb({ instruction: "i", query: "q", signal: aborted.signal }))
      .resolves.toEqual({ ok: false, searchCalls: 0 });
    expect(searchWeb).not.toHaveBeenCalled();
  } finally {
    searchWeb.mockRestore();
  }
});

test("每项路由只暴露自己那一项能力", () => {
  // 门面只构造一次：热路径复用同一对象，同时把每次真实模型调用纳入配额闸门。
  expect(textAiProvider()).not.toBe(geminiProvider);
  expect(summaryAiProvider()).not.toBe(openAiProvider);
  expect(textAiProvider()).toBe(textAiProvider());
  expect(summaryAiProvider()).toBe(summaryAiProvider());
  expect(typeof textAiProvider().createReplySession).toBe("function");
  expect(typeof summaryAiProvider().generateText).toBe("function");
  expect(typeof mediaAiProvider().describeVision).toBe("function");
  expect(typeof imageAiProvider()?.generateImage).toBe("function");
});

test("相同协议、端点和凭据的不同能力共享一个配额闸门", () => {
  agentConfig = {
    ...agentConfig,
    text: { provider: "openai", apiKey: "shared-key", baseUrl: "https://shared.example/v1", headers: undefined, model: "chat" },
    summary: { provider: "openai", apiKey: "shared-key", baseUrl: "https://shared.example/v1", headers: undefined, model: "summary" },
  };

  textAiProvider();
  summaryAiProvider();

  expect(aiProviderQuotaLanes).toHaveLength(1);
});

/** 暂时摘掉 OpenAI 实现包的语音合成，模拟「所选实现没有这项能力」；结束后原样装回。 */
function withoutOpenAiSpeech(run: () => void): void {
  const holder = openAiProvider as { synthesizeSpeech?: unknown };
  const synthesizeSpeech: unknown = holder.synthesizeSpeech;
  delete holder.synthesizeSpeech;
  try {
    run();
  } finally {
    holder.synthesizeSpeech = synthesizeSpeech;
  }
}

test("anthropic 没有生图能力：generateImage 缺席", () => {
  expect(anthropicProvider.generateImage).toBeUndefined();
});

test("media 选 anthropic 时语音转写缺席，只在启动时记一次诊断；正文、检索与结构化 JSON 照常路由到它", () => {
  const anthropic = { provider: "anthropic", apiKey: "anthropic-key", baseUrl: undefined, headers: undefined, model: "claude-test" } as const;
  agentConfig = { ...agentConfig, text: anthropic, media: anthropic, webSearch: { ...anthropic, maxCallsPerUse: 7 } };
  expect(anthropicProvider.transcribeVoice).toBeUndefined();
  expect(anthropicProvider.synthesizeSpeech).toBeUndefined();
  expect(textAiProvider().name).toBe("anthropic");
  expect(mediaAiProvider().transcribeVoice).toBeUndefined();
  expect(webSearchAiProvider()?.name).toBe("anthropic");
  expect(structuredTextAiProvider().name).toBe("anthropic");
  reportUnimplementedAgentCapabilities();
  expect(loggerWarn).toHaveBeenCalledTimes(1);
  expect(String(loggerWarn.mock.calls[0]![0])).toContain("$.agent.media");
  expect(loggerError).not.toHaveBeenCalled();
});

test("配了但这一家没实现的可选能力，只在启动时记一次诊断", () => {
  agentConfig = {
    ...agentConfig,
    tts: { provider: "openai", apiKey: "openai-tts-key", baseUrl: undefined, headers: undefined, model: "tts-model", voice: "Leda", speechProtocol: "openai", style: TTS_DEFAULT_STYLE, language: undefined, botLanguage: TTS_DEFAULT_BOT_LANGUAGE, dailyLimit: 100, dailyReserveQuota: 25 },
  };
  withoutOpenAiSpeech((): void => {
    expect(ttsAiProvider()).toEqual({ name: "openai" });
    reportUnimplementedAgentCapabilities();
  });
  expect(loggerWarn).toHaveBeenCalledTimes(1);
  expect(loggerError).not.toHaveBeenCalled();
  const diagnostic: string = String(loggerWarn.mock.calls[0]![0]);
  expect(diagnostic).toContain("$.agent.tts");
  expect(diagnostic).toContain(SEND_VOICE_TOOL);
  // 诊断不回显凭据。
  expect(diagnostic).not.toContain("openai-tts-key");
});

test("OpenAI 两种语音协议都经 tts 门面进入 OpenAI 实现包，xai 配置按端点与凭据归入已有配额 lane", async () => {
  const synthesizeSpeech = spyOn(openAiProvider, "synthesizeSpeech")
    .mockImplementation(async () => ({ bytes: new Uint8Array([0xFF, 0xF3]), mimeType: "audio/mpeg" }));
  try {
    agentConfig = {
      ...agentConfig,
      tts: {
        provider: "openai", apiKey: "xai-image-key", baseUrl: "https://xai.example/v1", headers: undefined, model: undefined,
        speechProtocol: "xai", voice: "ara", style: undefined, language: "auto", botLanguage: TTS_DEFAULT_BOT_LANGUAGE, dailyLimit: 100, dailyReserveQuota: 25,
      },
    };
    imageAiProvider();
    const lanes: number = aiProviderQuotaLanes.length;
    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "バカ", quota: "operator" }))
      .resolves.toEqual({ ok: true, speech: { bytes: new Uint8Array([0xFF, 0xF3]), mimeType: "audio/mpeg" } });
    expect(ttsAiProvider()?.name).toBe("openai");
    expect(aiProviderQuotaLanes).toHaveLength(lanes);
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    reportUnimplementedAgentCapabilities();
    expect(loggerWarn).not.toHaveBeenCalled();
  } finally {
    synthesizeSpeech.mockRestore();
    ttsDailyUsage.current = null;
  }
});

test("已实现的能力不刷诊断", () => {
  reportUnimplementedAgentCapabilities();
  expect(loggerWarn).not.toHaveBeenCalled();
});

/** 断言写在不会被调用的闭包内：闭包从不执行，`@ts-expect-error` 只在编译期生效。 */
test("跨能力调用无法通过类型检查", () => {
  const assertCrossCapabilityCallsRejected = (): void => {
    // 用完即弃的本地收集器，只为让每条断言成为一条语句。
    const rejected: unknown[] = [];
    // @ts-expect-error summary 路由只能生成摘要，不能拿去读图。
    rejected.push(summaryAiProvider().describeVision);
    // @ts-expect-error media 路由不能开回复会话。
    rejected.push(mediaAiProvider().createReplySession);
    // @ts-expect-error text 路由不能生成纯文本摘要。
    rejected.push(textAiProvider().generateText);
    // @ts-expect-error 生图路由不承载语音转写。
    rejected.push(imageAiProvider()?.transcribeVoice);
    // @ts-expect-error 语音合成路由不承载生图。
    rejected.push(ttsAiProvider()?.generateImage);
  };
  expect(typeof assertCrossCapabilityCallsRejected).toBe("function");
});

/**
 * 以下测试覆盖门面对配额闸门的包装：正常调用把 provider 结果原样透出；
 * 闸门拒收时返回各能力自身的「未成功」形状，不返回 undefined。
 */
const releases: (() => void)[] = [];

afterEach((): void => {
  for (const release of releases) release();
  releases.length = 0;
});

/** 返回一个由 afterEach 统一释放的悬挂 Promise，用来占住闸门的并发/等待位。 */
function hang<T>(): Promise<T> {
  return new Promise<T>((resolve: (value: T) => void): void => {
    releases.push((): void => resolve(undefined as T));
  });
}

test("摘要门面透出 provider 结果，并按后台额度排队", async () => {
  const generateText = spyOn(openAiProvider, "generateText")
    .mockImplementation(async () => ({ ok: true, text: "摘要正文" }) as never);
  try {
    await expect(summaryAiProvider().generateText({ prompt: "x" } as never))
      .resolves.toEqual({ ok: true, text: "摘要正文" });
    expect(generateText).toHaveBeenCalledTimes(1);
  } finally {
    generateText.mockRestore();
  }
});

test("后台额度占满时摘要按不可重试失败返回，不吐 undefined", async () => {
  const generateText = spyOn(openAiProvider, "generateText")
    .mockImplementation((): Promise<never> => hang());
  try {
    const summary = summaryAiProvider();
    // 并发位 + 后台等待位全部占满之后，下一次才会被闸门拒收。
    const saturating: Promise<unknown>[] = [];
    for (
      let index: number = 0;
      index < AI_PROVIDER_MAX_CONCURRENT + AI_PROVIDER_BACKGROUND_MAX_PENDING;
      index++
    ) saturating.push(summary.generateText({ prompt: "x" } as never));

    await expect(summary.generateText({ prompt: "x" } as never))
      .resolves.toEqual({ ok: false, retryable: false });
    expect(saturating).toHaveLength(
      AI_PROVIDER_MAX_CONCURRENT + AI_PROVIDER_BACKGROUND_MAX_PENDING
    );
  } finally {
    generateText.mockRestore();
  }
});

test("正文门面把整轮请求交给同一个会话，并透出这一轮的结果", async () => {
  const request = mock(async () => ({
    ok: true,
    text: "回复正文",
    functionCalls: [],
    webSearchCalls: 0,
    toolCallLimitHit: false,
  }) as never);
  const appendToolOutputs = mock((): void => {});
  const createReplySession = spyOn(geminiProvider, "createReplySession")
    .mockImplementation((): never => ({ request, appendToolOutputs }) as never);
  try {
    const session = textAiProvider().createReplySession({} as never);
    const turn = await session.request({} as never);

    expect(createReplySession).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(turn).toEqual(expect.objectContaining({ ok: true, text: "回复正文" }));
  } finally {
    createReplySession.mockRestore();
  }
});

test("正文门面没轮到执行（会话已取消）时交回本地队列满的不可用回合，不发起请求", async () => {
  const request = mock(async () => ({ ok: true }) as never);
  const createReplySession = spyOn(geminiProvider, "createReplySession")
    .mockImplementation((): never => ({ request, appendToolOutputs: (): void => {} }) as never);
  try {
    const aborted: AbortController = new AbortController();
    aborted.abort();
    const session = textAiProvider().createReplySession({ signal: aborted.signal } as never);
    const turn = await session.request({} as never);

    expect(request).not.toHaveBeenCalled();
    expect(turn).toEqual(expect.objectContaining({
      ok: false,
      text: null,
      functionCalls: [],
      finishReason: "LOCAL_PROVIDER_QUEUE_FULL",
      toolCallLimitHit: false,
    }));
  } finally {
    createReplySession.mockRestore();
  }
});

test("媒体门面的读图与转写都各自过闸并透出结果", async () => {
  const describeVision = spyOn(geminiProvider, "describeVision")
    .mockImplementation(async () => ({ ok: true, text: "一张图" }) as never);
  const transcribeVoice = spyOn(geminiProvider, "transcribeVoice")
    .mockImplementation(async () => ({ ok: true, text: "一段话" }) as never);
  try {
    const media = mediaAiProvider();

    await expect(media.describeVision({} as never)).resolves.toEqual({ ok: true, text: "一张图" });
    await expect(media.transcribeVoice?.({} as never)).resolves.toEqual({ ok: true, text: "一段话" });
    expect(describeVision).toHaveBeenCalledTimes(1);
    expect(transcribeVoice).toHaveBeenCalledTimes(1);
  } finally {
    describeVision.mockRestore();
    transcribeVoice.mockRestore();
  }
});

test("生图与语音合成门面透出 provider 结果", async () => {
  const generateImage = spyOn(openAiProvider, "generateImage")
    .mockImplementation(async () => ({ bytes: new Uint8Array([1]), mimeType: "image/png" }) as never);
  const synthesizeSpeech = spyOn(geminiProvider, "synthesizeSpeech")
    .mockImplementation(async () => ({ bytes: new Uint8Array([2]), mimeType: "audio/wav" }) as never);
  try {
    await expect(imageAiProvider()?.generateImage({} as never))
      .resolves.toEqual({ bytes: new Uint8Array([1]), mimeType: "image/png" });
    expect(ttsAiProvider()).toBe(ttsAiProvider());
    ttsDailyUsage.current = null;
    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "バカ", quota: "operator" }))
      .resolves.toEqual({ ok: true, speech: { bytes: new Uint8Array([2]), mimeType: "audio/wav" } });
  } finally {
    generateImage.mockRestore();
    synthesizeSpeech.mockRestore();
    ttsDailyUsage.current = null;
  }
});

test("语音合成门面对 operator 请求在发起前登记每日计数，达到上限时不发起请求", async () => {
  const synthesizeSpeech = spyOn(geminiProvider, "synthesizeSpeech")
    .mockImplementation(async () => ({ bytes: new Uint8Array([2]), mimeType: "audio/wav" }) as never);
  const reserveLimit: number = agentConfig.tts!.dailyReserveQuota;
  postMessage.mockClear();
  ttsDailyUsage.current = { windowStartedAt: Date.now() - 1_000, agentCount: 0, reserveCount: reserveLimit - 1 };
  try {
    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "バカ", quota: "operator" }))
      .resolves.toMatchObject({ ok: true });
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(ttsDailyUsage.current).toMatchObject({ agentCount: 0, reserveCount: reserveLimit });
    expect(postMessage).toHaveBeenCalledWith({ type: "ttsUsage", usage: ttsDailyUsage.current });

    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "バカ", quota: "operator" }))
      .resolves.toEqual({ ok: false, reason: "daily limit reached" });
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(ttsDailyUsage.current?.reserveCount).toBe(reserveLimit);

    // 排队期间已取消的请求不登记计数。
    ttsDailyUsage.current = null;
    const aborted: AbortController = new AbortController();
    aborted.abort();
    await ttsAiProvider()?.synthesizeSpeech?.({ text: "バカ", quota: "operator", signal: aborted.signal });
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(ttsDailyUsage.current).toBeNull();
  } finally {
    synthesizeSpeech.mockRestore();
    ttsDailyUsage.current = null;
  }
});

test("operator 请求的供应商没给出音频（返回 null 或抛错）时退还登记，成功不退", async () => {
  const synthesizeSpeech = spyOn(geminiProvider, "synthesizeSpeech");
  const before: TtsDailyUsage = { windowStartedAt: Date.now() - 1_000, agentCount: 1, reserveCount: 2 };
  try {
    synthesizeSpeech.mockImplementationOnce(async () => null);
    ttsDailyUsage.current = before;
    postMessage.mockClear();
    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "バカ", quota: "operator" }))
      .resolves.toEqual({ ok: false, reason: "synthesis failed" });
    expect(ttsDailyUsage.current).toEqual(before);
    expect(postMessage.mock.calls.map((call: unknown[]) => (call[0] as { usage: unknown }).usage)).toEqual([
      { ...before, reserveCount: 3 },
      before,
    ]);

    synthesizeSpeech.mockImplementationOnce(async () => { throw new Error("provider exploded"); });
    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "バカ", quota: "operator" })).rejects.toThrow("provider exploded");
    expect(ttsDailyUsage.current).toEqual(before);

    // 从没用过时登记后又退还：两项皆 0，回传 null。
    synthesizeSpeech.mockImplementationOnce(async () => null);
    ttsDailyUsage.current = null;
    postMessage.mockClear();
    await ttsAiProvider()?.synthesizeSpeech?.({ text: "バカ", quota: "operator" });
    expect(ttsDailyUsage.current).toBeNull();
    expect(postMessage).toHaveBeenLastCalledWith({ type: "ttsUsage", usage: null });

    synthesizeSpeech.mockImplementationOnce(async () => ({ bytes: new Uint8Array([2]), mimeType: "audio/wav" }) as never);
    ttsDailyUsage.current = before;
    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "バカ", quota: "operator" })).resolves.toMatchObject({ ok: true });
    expect(ttsDailyUsage.current).toEqual({ ...before, reserveCount: 3 });
  } finally {
    synthesizeSpeech.mockRestore();
    ttsDailyUsage.current = null;
  }
});

test("ai 口径由调用方预留与登记，门面不再登记，额度用尽也照常发起请求", async () => {
  const synthesizeSpeech = spyOn(geminiProvider, "synthesizeSpeech").mockImplementation(async () => null);
  const agentLimit: number = agentConfig.tts!.dailyLimit - agentConfig.tts!.dailyReserveQuota;
  ttsDailyUsage.current = { windowStartedAt: Date.now(), agentCount: agentLimit, reserveCount: 0 };
  postMessage.mockClear();
  try {
    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "hi", quota: "ai" }))
      .resolves.toEqual({ ok: false, reason: "synthesis failed" });
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(ttsDailyUsage.current).toMatchObject({ agentCount: agentLimit, reserveCount: 0 });
    expect(postMessage).not.toHaveBeenCalled();
  } finally {
    synthesizeSpeech.mockRestore();
    ttsDailyUsage.current = null;
  }
});

test("预留额度用尽时门面拒绝 operator，AI 仍能请求且门面不改计数", async () => {
  const synthesizeSpeech = spyOn(geminiProvider, "synthesizeSpeech").mockImplementation(async () => null);
  const reserveCount: number = agentConfig.tts!.dailyReserveQuota;
  ttsDailyUsage.current = { windowStartedAt: Date.now(), agentCount: 0, reserveCount };
  postMessage.mockClear();
  try {
    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "hi", quota: "operator" }))
      .resolves.toEqual({ ok: false, reason: "daily limit reached" });
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    await expect(ttsAiProvider()?.synthesizeSpeech?.({ text: "hi", quota: "ai" }))
      .resolves.toEqual({ ok: false, reason: "synthesis failed" });
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(ttsDailyUsage.current).toMatchObject({ agentCount: 0, reserveCount });
  } finally {
    synthesizeSpeech.mockRestore();
    ttsDailyUsage.current = null;
  }
});

test("agent 热重载丢弃门面与 SDK 客户端，按新快照重建", () => {
  const oldText = textAiProvider();
  const oldSummary = summaryAiProvider();
  geminiClientCache.current = new Map();
  openAiClientCache.current = new Map();

  reloadAgentDeploymentConfig({
    ...agentConfig,
    text: { ...agentConfig.text, model: "gemini-text-reloaded" },
    tts: undefined,
  });

  expect(textAiProvider()).not.toBe(oldText);
  expect(summaryAiProvider()).not.toBe(oldSummary);
  expect(ttsAiProvider()).toBeNull();
  expect(geminiClientCache.current).toBeNull();
  expect(openAiClientCache.current).toBeNull();
});

test("agent 热重载保留仍被引用的配额 lane，摘除失去引用的 lane", () => {
  textAiProvider();
  summaryAiProvider();
  ttsAiProvider();
  expect(aiProviderQuotaLanes.map((lane) => lane.apiKey)).toEqual([
    "google-text-key",
    "openai-summary-key",
    "google-tts-key",
  ]);
  const summaryLane = aiProviderQuotaLanes[1]!;

  reloadAgentDeploymentConfig({
    ...agentConfig,
    text: { ...agentConfig.text, apiKey: "google-text-key-rotated" },
    summary: { ...agentConfig.summary, model: "gpt-summary-reloaded" },
  });

  // text 换了凭据：旧 lane 失去引用被摘除；summary 只换模型，并发额度原样延续。
  expect(aiProviderQuotaLanes.map((lane) => lane.apiKey)).toEqual([
    "openai-summary-key",
    "google-tts-key",
  ]);
  summaryAiProvider();
  expect(aiProviderQuotaLanes[0]).toBe(summaryLane);
  textAiProvider();
  expect(aiProviderQuotaLanes.map((lane) => lane.apiKey)).toContain("google-text-key-rotated");
});

test("只有 media 能力变化时两种输入模态才回到未探测状态", () => {
  recordMediaInputResult({
    capability: "voice",
    result: { ok: false, retryable: false, mediaFailure: "unsupported" },
    attemptState: getMediaInputState("voice"),
  });

  reloadAgentDeploymentConfig({ ...agentConfig, text: { ...agentConfig.text, model: "other-text" } });
  expect(getMediaInputState("voice").support).toBe("unsupported");

  reloadAgentDeploymentConfig({ ...agentConfig, media: { ...agentConfig.media, model: "gemini-media-2" } });
  expect(getMediaInputState("voice").support).toBe("unknown");
  expect(getMediaInputState("voice").configGeneration).toBe(1);
});

test("只有 text 能力变化时才丢弃 Gemini 回复共用显式缓存的登记表", () => {
  const registry: GeminiContextCacheRegistry = createGeminiContextCacheRegistry({} as unknown as GoogleGenAI);
  textGeminiContextCache.current = registry;

  reloadAgentDeploymentConfig({ ...agentConfig, media: { ...agentConfig.media, model: "gemini-media-2" } });
  expect(textGeminiContextCache.current).toBe(registry);

  reloadAgentDeploymentConfig({ ...agentConfig, text: { ...agentConfig.text, apiKey: "google-text-key-rotated" } });
  expect(textGeminiContextCache.current).toBeNull();
});

test("agent 热重载后按新快照重记「配了但没实现」的诊断", () => {
  withoutOpenAiSpeech((): void => {
    reloadAgentDeploymentConfig({
      ...agentConfig,
      tts: { provider: "openai", apiKey: "openai-tts-key", baseUrl: undefined, headers: undefined, model: "tts-model", voice: "Leda", speechProtocol: "openai", style: TTS_DEFAULT_STYLE, language: undefined, botLanguage: TTS_DEFAULT_BOT_LANGUAGE, dailyLimit: 100, dailyReserveQuota: 25 },
    });
  });
  expect(loggerWarn).toHaveBeenCalledTimes(1);
  expect(String(loggerWarn.mock.calls[0]![0])).toContain("$.agent.tts");
});

test("agent 热重载删除 tts 后摘除它独占的配额 lane", () => {
  ttsAiProvider();
  const ttsLane = aiProviderQuotaLanes.find((lane) => lane.apiKey === "google-tts-key");
  expect(ttsLane).toBeDefined();

  reloadAgentDeploymentConfig({ ...agentConfig, text: { ...agentConfig.text, model: "other-text" } });

  expect(aiProviderQuotaLanes).toContain(ttsLane!);
  reloadAgentDeploymentConfig({ ...agentConfig, tts: undefined });
  expect(aiProviderQuotaLanes).not.toContain(ttsLane!);
  expect(ttsAiProvider()).toBeNull();
});
