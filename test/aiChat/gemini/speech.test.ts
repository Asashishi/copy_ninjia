/**
 * Gemini 语音合成适配器：Interactions API 的请求映射（台词、speech_metadata 风格、
 * 预置音色、音频响应格式）、超时与重试传参，以及响应载荷门禁。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { adoptAgentDeploymentConfig, getAgentDeploymentConfig } from "../../../packages/config/agent";
import { parseTtsCapability } from "../../../packages/config/agentCapability";
import { installAiCacheUsageSink } from "../../../packages/infra/aiCacheUsage";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import { VOICE_SPEECH_MAX_BYTES } from "../../../packages/consts/aiChat/voiceMessage";
import type { SynthesizedSpeech } from "../../../packages/types/aiChat/voiceMessage";

const create = mock(async (..._args: unknown[]): Promise<unknown> => ({}));
const getGeminiClient = mock((_capability: string): unknown => ({ interactions: { create } }));
const loggerError = mock((..._args: unknown[]): void => {});

mock.module("../../../packages/aiChat/gemini/client", () => ({ getGeminiClient }));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { synthesizeGeminiSpeech } = await import("../../../packages/aiChat/gemini/speech");
const {
  GEMINI_SPEECH_REQUEST_ATTEMPTS,
  GEMINI_SPEECH_REQUEST_TIMEOUT_MS,
  GEMINI_SPEECH_STYLE,
  GEMINI_SPEECH_TEMPERATURE,
  GEMINI_SPEECH_TONE_SEPARATOR,
} = await import("../../../packages/consts/aiChat/gemini");

const WAV_BYTES: Uint8Array = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
const INITIAL_CONFIG = getAgentDeploymentConfig();

function audioInteraction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    output_audio: { type: "audio", data: WAV_BYTES.toBase64(), mime_type: "audio/wav" },
    ...overrides,
  };
}

beforeEach(() => {
  create.mockClear();
  getGeminiClient.mockClear();
  loggerError.mockClear();
  create.mockResolvedValue(audioInteraction());
});

afterEach(() => {
  adoptAgentDeploymentConfig(INITIAL_CONFIG);
  installAiCacheUsageSink(null);
});

describe("Gemini 语音合成适配器", () => {
  test("动态替换 style 后仅新请求使用新快照，删除配置字段恢复默认", async () => {
    const base = { provider: "google", api_key: "fixture-key", model: "fixture-model", voice: "fixture-voice" };
    adoptAgentDeploymentConfig({ ...INITIAL_CONFIG, tts: parseTtsCapability({ ...base, style: " first " }, "fixture.json") });
    let finish!: (value: unknown) => void;
    create.mockImplementationOnce(() => new Promise((resolve): void => { finish = resolve; }));
    const pending = synthesizeGeminiSpeech({ text: "a", tone: "tone" });
    adoptAgentDeploymentConfig({ ...INITIAL_CONFIG, tts: parseTtsCapability({ ...base, style: "second" }, "fixture.json") });
    await synthesizeGeminiSpeech({ text: "b" });
    adoptAgentDeploymentConfig({ ...INITIAL_CONFIG, tts: parseTtsCapability(base, "fixture.json") });
    await synthesizeGeminiSpeech({ text: "c" });
    finish(audioInteraction());
    await pending;
    const styles = create.mock.calls.map(([body]) => (body as any).input[0].content[0].annotations[0].style);
    expect(styles).toEqual([`first${GEMINI_SPEECH_TONE_SEPARATOR}tone`, "second", GEMINI_SPEECH_STYLE]);
    const checkReadonly = (): void => {
      // @ts-expect-error 配置解析结果的基础风格不可由调用方改写
      getAgentDeploymentConfig().tts!.style = "mutation";
    };
    void checkReadonly;
  });

  test("收到带 usage 的音频或不可用载荷都计数一次，取消前未发请求不计数", async () => {
    const reported: AiCacheUsage[] = [];
    installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
    const usage = { total_input_tokens: 3, total_output_tokens: 20, total_thought_tokens: 2 };
    create.mockResolvedValueOnce(audioInteraction({ usage }));
    create.mockResolvedValueOnce({ usage });
    await synthesizeGeminiSpeech({ text: "a" });
    await synthesizeGeminiSpeech({ text: "b" });
    await synthesizeGeminiSpeech({ text: "c", signal: AbortSignal.abort() });
    expect(reported).toHaveLength(2);
    expect(reported).toMatchObject([
      { capability: "tts", inputTokens: 3, cachedInputTokens: null, outputTokens: 22 },
      { capability: "tts", inputTokens: 3, cachedInputTokens: null, outputTokens: 22 },
    ]);
  });
  test("台词带 speech_metadata 风格、采样温度与音频响应格式，模型名与音色取自 tts 能力", async () => {
    const speech: SynthesizedSpeech | null = await synthesizeGeminiSpeech({ text: "この雑魚♡" });

    expect(getGeminiClient).toHaveBeenCalledWith("tts");
    // 音色与模型名按示例配置取值，不在测试里写死具体值。
    expect(getAgentDeploymentConfig().tts?.voice).toEqual(expect.any(String));
    expect(create.mock.calls[0]![0]).toEqual({
      model: getAgentDeploymentConfig().tts?.model,
      input: [{
        type: "user_input",
        content: [{
          type: "text",
          text: "この雑魚♡",
          annotations: [{ type: "speech_metadata", style: getAgentDeploymentConfig().tts?.style }],
        }],
      }],
      response_format: { type: "audio" },
      generation_config: {
        speech_config: [{ voice: getAgentDeploymentConfig().tts?.voice }],
        temperature: GEMINI_SPEECH_TEMPERATURE,
      },
    });
    expect(speech).toEqual({ bytes: WAV_BYTES, mimeType: "audio/wav" });
  });

  test("给出本句语气时拼在基础风格之后，只作用于这一句", async () => {
    await synthesizeGeminiSpeech({ text: "バカ", tone: "鼻で笑うように" });
    const body = create.mock.calls[0]![0] as {
      input: readonly { content: readonly { annotations: readonly { style: string }[] }[] }[];
    };
    expect(body.input[0]!.content[0]!.annotations[0]!.style)
      .toBe(`${getAgentDeploymentConfig().tts?.style}${GEMINI_SPEECH_TONE_SEPARATOR}鼻で笑うように`);
  });

  test("每次调用显式带超时、重试次数与合成后的 signal", async () => {
    const controller: AbortController = new AbortController();
    await synthesizeGeminiSpeech({ text: "バカ", signal: controller.signal });

    const options = create.mock.calls[0]![1] as { timeout: number; maxRetries: number; signal: AbortSignal };
    expect(options.timeout).toBe(GEMINI_SPEECH_REQUEST_TIMEOUT_MS);
    expect(options.maxRetries).toBe(GEMINI_SPEECH_REQUEST_ATTEMPTS - 1);
    expect(options.signal).not.toBe(controller.signal);
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });

  test("调用前已作废时不发请求也不记日志；等待中作废立即返回 null", async () => {
    const reported: AiCacheUsage[] = [];
    installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
    const aborted: AbortController = new AbortController();
    aborted.abort();
    await expect(synthesizeGeminiSpeech({ text: "p", signal: aborted.signal })).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();

    const controller: AbortController = new AbortController();
    let settle!: (value: unknown) => void;
    const pending: Promise<unknown> = new Promise<unknown>((resolve: (value: unknown) => void): void => {
      settle = resolve;
    });
    create.mockImplementationOnce((): Promise<unknown> => pending);
    const result: Promise<SynthesizedSpeech | null> = synthesizeGeminiSpeech({ text: "p", signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(loggerError).not.toHaveBeenCalled();
    settle(audioInteraction({ usage: { total_input_tokens: 7, total_output_tokens: 9 } }));
    await pending;
    await Promise.resolve();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ inputTokens: 7, outputTokens: 9 });
  });

  test("请求失败归一成 null 并记英文日志", async () => {
    create.mockRejectedValueOnce(new Error("boom"));
    await expect(synthesizeGeminiSpeech({ text: "p" })).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledWith("Error calling Gemini speech synthesis API:", expect.any(Error));
  });

  test("没有音频或载荷不合格时带原因记日志", async () => {
    create.mockResolvedValueOnce({});
    await expect(synthesizeGeminiSpeech({ text: "p" })).resolves.toBeNull();

    create.mockResolvedValueOnce(audioInteraction({
      output_audio: { type: "audio", data: WAV_BYTES.toBase64() },
    }));
    await expect(synthesizeGeminiSpeech({ text: "p" })).resolves.toBeNull();

    create.mockResolvedValueOnce(audioInteraction({
      output_audio: { type: "audio", data: new Uint8Array(VOICE_SPEECH_MAX_BYTES + 1).toBase64(), mime_type: "audio/wav" },
    }));
    await expect(synthesizeGeminiSpeech({ text: "p" })).resolves.toBeNull();

    const messages: string[] = loggerError.mock.calls.map((call: unknown[]): string => String(call[0]));
    expect(messages[0]).toBe("Gemini speech synthesis API returned no audio payload.");
    expect(messages[1]).toContain("missing audio mime type");
    expect(messages[2]).toContain("exceeds the size limit");
  });
});
