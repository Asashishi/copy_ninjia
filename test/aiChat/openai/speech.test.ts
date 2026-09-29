/**
 * OpenAI 实现包的语音合成：按 speech_protocol 分派到 OpenAI audio/speech（SDK）与 xAI
 * `POST /tts`（fetch）。核对两种请求形状、按请求格式标注的 OGG/Opus 与 MP3 结果、用量缺失诊断、有界响应体、
 * xai 的重试口径与取消语义。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { parseTtsCapability } from "../../../packages/config/agentCapability";
import { installAiCacheUsageSink } from "../../../packages/infra/aiCacheUsage";
import type { AgentDeploymentConfig, AgentTtsCapabilityConfig } from "../../../packages/types/config";
import type { SynthesizedSpeech } from "../../../packages/types/aiChat/voiceMessage";

const speechCreate = mock(async (..._args: unknown[]): Promise<Response> => new Response(new Uint8Array([1, 0, 2, 0])));
const getOpenAiClient = mock((_capability: string): unknown => ({ audio: { speech: { create: speechCreate } } }));
const loggerError = mock((..._args: unknown[]): void => {});
const loggerWarn = mock((..._args: unknown[]): void => {});
const sleep = mock(async (_ms: number, _signal?: AbortSignal): Promise<void> => {});
let tts: AgentTtsCapabilityConfig | undefined;
/** 非 null 时 agent 配置读取按它抛错（模拟本线程从未收到 agent 快照）。 */
let configError: Error | null = null;

mock.module("../../../packages/aiChat/openai/client", () => ({ getOpenAiClient }));
mock.module("../../../packages/libs/sleep", () => ({ sleep }));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError, warn: loggerWarn }) }));
mock.module("../../../packages/config/agent", () => ({
  getAgentDeploymentConfig: (): AgentDeploymentConfig => {
    if (configError !== null) throw configError;
    return {
      text: { provider: "openai", apiKey: "text-key", baseUrl: undefined, headers: undefined, model: "t" },
      summary: { provider: "openai", apiKey: "summary-key", baseUrl: undefined, headers: undefined, model: "s" },
      media: { provider: "openai", apiKey: "media-key", baseUrl: undefined, headers: undefined, model: "m" },
      tts,
    };
  },
}));

const { synthesizeOpenAiSpeech } = await import("../../../packages/aiChat/openai/speech");
const {
  OPENAI_SPEECH_ERROR_LABEL,
  OPENAI_SPEECH_REQUEST_ATTEMPTS,
  OPENAI_SPEECH_REQUEST_TIMEOUT_MS,
  OPENAI_SPEECH_RESPONSE_FORMAT,
  XAI_API_BASE_URL,
  XAI_SPEECH_BIT_RATE,
  XAI_SPEECH_CODEC,
  XAI_SPEECH_ERROR_LABEL,
  XAI_SPEECH_RETRY_BASE_DELAY_MS,
  XAI_SPEECH_SAMPLE_RATE,
} = await import("../../../packages/consts/aiChat/openai");
const { TTS_TONE_SEPARATOR, VOICE_SPEECH_MAX_BYTES } = await import("../../../packages/consts/aiChat/voiceMessage");
const { MP3_MIME_TYPE, OGG_OPUS_MIME_TYPE } = await import("../../../packages/consts/audio");

/** 响应体替身；容器结构由编码侧校验，这里只核对字节原样交回。 */
const AUDIO: Uint8Array = new Uint8Array([1, 0, 2, 0, 3, 0]);
const ORIGINAL_FETCH: typeof fetch = globalThis.fetch;
const fetchMock = mock(async (_input: unknown, _init?: RequestInit): Promise<Response> => audioResponse(AUDIO));

function audioResponse(bytes: Uint8Array, status: number = 200): Response {
  return new Response(bytes, { status, headers: { "content-type": "audio/mpeg" } });
}

function openAiTts(extra: Readonly<Record<string, unknown>> = {}): AgentTtsCapabilityConfig {
  return parseTtsCapability(
    { provider: "openai", api_key: "openai-tts-key", model: "fixture-tts", speech_protocol: "openai", voice: "coral", ...extra },
    "fixture.json"
  );
}

function xAiTts(extra: Readonly<Record<string, unknown>> = {}): AgentTtsCapabilityConfig {
  return parseTtsCapability(
    { provider: "openai", api_key: "xai-tts-key", speech_protocol: "xai", voice: "ara", ...extra },
    "fixture.json"
  );
}

/** 第 index 次 fetch 调用的 URL、init 与解析后的 JSON 请求体。 */
function fetchCall(index: number): { url: string; init: RequestInit; body: unknown } {
  const [input, init] = fetchMock.mock.calls[index]!;
  return { url: String(input), init: init!, body: JSON.parse(String(init!.body)) };
}

beforeEach(() => {
  speechCreate.mockReset().mockImplementation(async () => new Response(AUDIO));
  getOpenAiClient.mockClear();
  loggerError.mockClear();
  loggerWarn.mockClear();
  sleep.mockClear();
  fetchMock.mockReset().mockImplementation(async () => audioResponse(AUDIO));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  installAiCacheUsageSink(null);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  tts = undefined;
  configError = null;
});

describe("openai 协议（audio/speech）", () => {
  test("台词、音色、模型与风格指令按配置快照发送，响应体按 OGG/Opus 交回", async () => {
    tts = openAiTts({ style: "base style" });
    const speech: SynthesizedSpeech | null = await synthesizeOpenAiSpeech({ text: "バカ", tone: "鼻で笑うように" });

    expect(getOpenAiClient).toHaveBeenCalledWith("tts");
    const [body, options] = speechCreate.mock.calls[0]! as [unknown, { signal: AbortSignal; timeout: number; maxRetries: number }];
    expect(body).toEqual({
      model: tts.model,
      voice: tts.voice,
      input: "バカ",
      instructions: `${tts.style}${TTS_TONE_SEPARATOR}鼻で笑うように`,
      response_format: OPENAI_SPEECH_RESPONSE_FORMAT,
    });
    expect(options.timeout).toBe(OPENAI_SPEECH_REQUEST_TIMEOUT_MS);
    expect(options.maxRetries).toBe(OPENAI_SPEECH_REQUEST_ATTEMPTS - 1);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(speech).toEqual({ bytes: AUDIO, mimeType: OGG_OPUS_MIME_TYPE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("没有语气时只发基础风格；响应不带用量，只记一次 missing 诊断", async () => {
    tts = openAiTts();
    await synthesizeOpenAiSpeech({ text: "a" });
    await synthesizeOpenAiSpeech({ text: "b" });
    expect((speechCreate.mock.calls[0]![0] as { instructions: string }).instructions).toBe(tts.style!);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(String(loggerWarn.mock.calls[0]![0])).toContain("capability=tts, provider=openai, reason=missing");
  });

  test("请求失败记错误日志返回 null；调用方取消静默返回 null", async () => {
    tts = openAiTts();
    speechCreate.mockRejectedValueOnce(new Error("503 upstream"));
    await expect(synthesizeOpenAiSpeech({ text: "a" })).resolves.toBeNull();
    expect(String(loggerError.mock.calls[0]![0])).toContain(OPENAI_SPEECH_ERROR_LABEL);

    loggerError.mockClear();
    await expect(synthesizeOpenAiSpeech({ text: "a", signal: AbortSignal.abort() })).resolves.toBeNull();
    expect(speechCreate).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });

  test("响应体超过合成上限时不保留部分字节，按不可用载荷记日志", async () => {
    tts = openAiTts();
    speechCreate.mockImplementationOnce(async () => new Response(new Uint8Array(VOICE_SPEECH_MAX_BYTES + 2)));
    await expect(synthesizeOpenAiSpeech({ text: "a" })).resolves.toBeNull();
    expect(String(loggerError.mock.calls[0]![0])).toContain("audio body exceeds the size limit");
  });

  test("agent 配置读取失败时不发请求，记错误日志返回 null", async () => {
    configError = new Error("agent configuration is unavailable");
    await expect(synthesizeOpenAiSpeech({ text: "a" })).resolves.toBeNull();
    expect(speechCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0]).toEqual([`Error calling ${OPENAI_SPEECH_ERROR_LABEL}:`, configError]);
  });

  test("tts 未选 OpenAI 协议时不发请求，记错误日志返回 null", async () => {
    tts = parseTtsCapability({ provider: "google", api_key: "k", model: "m", voice: "Leda" }, "fixture.json");
    await expect(synthesizeOpenAiSpeech({ text: "a" })).resolves.toBeNull();
    expect(speechCreate).not.toHaveBeenCalled();
    expect(String(loggerError.mock.calls[0]![0])).toContain(OPENAI_SPEECH_ERROR_LABEL);
  });
});

describe("xai 协议（POST /tts，fetch）", () => {
  test("缺省端点、Bearer 认证、不跟随重定向；请求体只有台词、音色、语言与 MP3 输出格式", async () => {
    tts = xAiTts();
    const speech: SynthesizedSpeech | null = await synthesizeOpenAiSpeech({ text: "バカ", tone: "鼻で笑うように" });

    expect(speechCreate).not.toHaveBeenCalled();
    const { url, init, body } = fetchCall(0);
    expect(url).toBe(`${XAI_API_BASE_URL}/tts`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${tts.apiKey}`);
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(body).toEqual({
      text: "バカ",
      voice_id: tts.voice,
      language: tts.language,
      output_format: { codec: XAI_SPEECH_CODEC, sample_rate: XAI_SPEECH_SAMPLE_RATE, bit_rate: XAI_SPEECH_BIT_RATE },
    });
    expect(speech).toEqual({ bytes: AUDIO, mimeType: MP3_MIME_TYPE });
    expect(String(loggerWarn.mock.calls[0]![0])).toContain("capability=tts, provider=openai, reason=missing");
  });

  test("配置的 base_url 带或不带末尾斜杠都拼成同一个 /tts 端点", async () => {
    for (const baseUrl of ["https://proxy.example/xai/v1", "https://proxy.example/xai/v1/"]) {
      tts = xAiTts({ base_url: baseUrl, language: "ja" });
      await synthesizeOpenAiSpeech({ text: "a" });
    }
    expect(fetchCall(0).url).toBe("https://proxy.example/xai/v1/tts");
    expect(fetchCall(1).url).toBe("https://proxy.example/xai/v1/tts");
    expect(fetchCall(1).body).toMatchObject({ language: "ja" });
  });

  test("网络错误与 408/429/5xx 在尝试上限内退避重试，退避逐次翻倍", async () => {
    tts = xAiTts();
    fetchMock
      .mockImplementationOnce(async () => { throw new TypeError("connection reset"); })
      .mockImplementationOnce(async () => audioResponse(new Uint8Array(), 503));
    await expect(synthesizeOpenAiSpeech({ text: "a" })).resolves.toEqual({
      bytes: AUDIO, mimeType: MP3_MIME_TYPE,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([XAI_SPEECH_RETRY_BASE_DELAY_MS, XAI_SPEECH_RETRY_BASE_DELAY_MS * 2]);
    expect(loggerError).not.toHaveBeenCalled();

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => new Response("slow down", { status: 429 }));
    await expect(synthesizeOpenAiSpeech({ text: "a" })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(OPENAI_SPEECH_REQUEST_ATTEMPTS);
    expect(String(loggerError.mock.calls[0]![0])).toContain(XAI_SPEECH_ERROR_LABEL);
    expect(String(loggerError.mock.calls[0]![1])).toContain("HTTP 429: slow down");
  });

  test("其余非 2xx（含未跟随的重定向）不重试，错误日志带状态码与有界响应体", async () => {
    tts = xAiTts();
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"unknown voice"}', { status: 400 }));
    await expect(synthesizeOpenAiSpeech({ text: "a" })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(String(loggerError.mock.calls[0]![1])).toContain('HTTP 400: {"error":"unknown voice"}');

    fetchMock.mockImplementationOnce(async () => new Response("", { status: 302, headers: { location: "https://elsewhere.example/tts" } }));
    await expect(synthesizeOpenAiSpeech({ text: "a" })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(String(loggerError.mock.calls[1]![1])).toContain("HTTP 302");
  });

  test("调用方取消时不发请求也不记错误；请求中途取消同样静默", async () => {
    tts = xAiTts();
    await expect(synthesizeOpenAiSpeech({ text: "a", signal: AbortSignal.abort() })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const controller: AbortController = new AbortController();
    fetchMock.mockImplementationOnce(async (_input: unknown, init?: RequestInit): Promise<Response> => {
      controller.abort();
      init!.signal!.throwIfAborted();
      return audioResponse(AUDIO);
    });
    await expect(synthesizeOpenAiSpeech({ text: "a", signal: controller.signal })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });
});
