/**
 * 语音合成公共实现（aiChat/ai/voiceSynthesis.ts）与 AI Worker 侧转交处理：入口查找、
 * 合成后编码、取消与失败归类，以及回执转移语音 buffer、撤回中止在途合成。
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { sineWav } from "../../helpers/wav";
import type { AiSpeechRequest } from "../../../packages/types/aiChat/provider";
import type { SynthesizedSpeech } from "../../../packages/types/aiChat/voiceMessage";

const originalSelfDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(globalThis, "self");
const postMessage = mock((..._args: unknown[]): void => {});
Object.defineProperty(globalThis, "self", { configurable: true, value: { postMessage } });

const synthesizeSpeech = mock(async (_request: AiSpeechRequest): Promise<SynthesizedSpeech | null> => ({
  bytes: sineWav(24_000, 0.5),
  mimeType: "audio/wav",
}));
const ttsAiProvider = mock((): unknown => ({ name: "google", synthesizeSpeech }));
const loggerError = mock((..._args: unknown[]): void => {});
const realProvider = await import("../../../packages/aiChat/provider");
mock.module("../../../packages/aiChat/provider", () => ({ ...realProvider, ttsAiProvider }));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { resolveSpeechSynthesizer, synthesizeVoiceMessage } = await import("../../../packages/aiChat/ai/voiceSynthesis");
const { handleCancelVoiceSynthesis, handleSynthesizeVoice } = await import("../../../packages/workers/aiChat/voiceSynthesis");
const { voiceSynthesisRequests } = await import("../../../packages/cache/workers/aiChat/voiceSynthesis");
const { aiChatWorkerAbortController, aiChatWorkerQuiescing } = await import("../../../packages/cache/workers/aiChat/worker");

/** 等下一条回执。 */
async function nextEvent(): Promise<[unknown, unknown]> {
  for (let tick: number = 0; tick < 200 && postMessage.mock.calls.length === 0; tick++) await Bun.sleep(1);
  return postMessage.mock.calls[0] as [unknown, unknown];
}

beforeEach(() => {
  postMessage.mockClear();
  synthesizeSpeech.mockClear();
  synthesizeSpeech.mockImplementation(async (): Promise<SynthesizedSpeech | null> => ({
    bytes: sineWav(24_000, 0.5),
    mimeType: "audio/wav",
  }));
  ttsAiProvider.mockImplementation((): unknown => ({ name: "google", synthesizeSpeech }));
  loggerError.mockClear();
  aiChatWorkerQuiescing.current = false;
  aiChatWorkerAbortController.current = new AbortController();
  voiceSynthesisRequests.clear();
});

afterAll(() => {
  if (originalSelfDescriptor === undefined) Reflect.deleteProperty(globalThis, "self");
  else Object.defineProperty(globalThis, "self", originalSelfDescriptor);
});

describe("公共实现", () => {
  test("入口查找：未配置、所选实现不支持与可用三种结论", () => {
    ttsAiProvider.mockImplementation((): unknown => null);
    expect(resolveSpeechSynthesizer()).toEqual({ ok: false, reason: "tts unconfigured", providerName: undefined });
    ttsAiProvider.mockImplementation((): unknown => ({ name: "openai" }));
    expect(resolveSpeechSynthesizer()).toEqual({ ok: false, reason: "tts unsupported", providerName: "openai" });
    ttsAiProvider.mockImplementation((): unknown => ({ name: "google", synthesizeSpeech }));
    expect(resolveSpeechSynthesizer()).toEqual({ ok: true, synthesize: synthesizeSpeech });
  });

  test("合成后编码成 OGG/Opus；合成返回空、signal 已中止与编码失败各自归类", async () => {
    const encoded = await synthesizeVoiceMessage(synthesizeSpeech, { text: "hi", tone: "小声で" }, "test");
    expect(encoded.ok).toBeTrue();
    if (!encoded.ok) throw new Error("expected encoded voice");
    expect(new TextDecoder().decode(encoded.voice.bytes.subarray(0, 4))).toBe("OggS");
    expect(encoded.voice.durationSeconds).toBe(1);
    expect(synthesizeSpeech).toHaveBeenCalledWith({ text: "hi", tone: "小声で" });

    synthesizeSpeech.mockImplementationOnce(async (): Promise<null> => null);
    expect(await synthesizeVoiceMessage(synthesizeSpeech, { text: "hi" }, "test")).toEqual({ ok: false, reason: "synthesis failed" });

    const controller: AbortController = new AbortController();
    synthesizeSpeech.mockImplementationOnce(async (): Promise<SynthesizedSpeech> => {
      controller.abort();
      return { bytes: sineWav(24_000, 0.5), mimeType: "audio/wav" };
    });
    expect(await synthesizeVoiceMessage(synthesizeSpeech, { text: "hi", signal: controller.signal }, "test"))
      .toEqual({ ok: false, reason: "aborted" });

    synthesizeSpeech.mockImplementationOnce(async (): Promise<SynthesizedSpeech> => ({ bytes: new Uint8Array([1]), mimeType: "audio/mp3" }));
    expect(await synthesizeVoiceMessage(synthesizeSpeech, { text: "hi" }, "chat -1")).toEqual({ ok: false, reason: "unsupported speech mime type" });
    expect(loggerError).toHaveBeenCalledWith("Voice message encoding failed (chat -1): unsupported speech mime type.");
  });
});

describe("AI Worker 侧转交", () => {
  test("成功回执带回语音并转移 buffer，在途条目随结算摘除", async () => {
    handleSynthesizeVoice({ type: "synthesizeVoice", requestId: 7, text: "おやすみ", tone: "眠そうに" });
    expect(voiceSynthesisRequests.has(7)).toBeTrue();
    const [event, transfer] = await nextEvent();
    const typed = event as { type: string; requestId: number; result: { ok: true; voice: { bytes: Uint8Array } } };
    expect(typed.type).toBe("voiceSynthesized");
    expect(typed.requestId).toBe(7);
    expect(typed.result.ok).toBeTrue();
    expect(transfer).toEqual([typed.result.voice.bytes.buffer]);
    expect(synthesizeSpeech.mock.calls[0]![0]).toMatchObject({ text: "おやすみ", tone: "眠そうに" });
    expect(voiceSynthesisRequests.size).toBe(0);
  });

  test("能力缺席与排空期间直接回失败，不合成", async () => {
    ttsAiProvider.mockImplementation((): unknown => null);
    handleSynthesizeVoice({ type: "synthesizeVoice", requestId: 1, text: "hi", tone: undefined });
    expect(await nextEvent()).toEqual([
      { type: "voiceSynthesized", requestId: 1, result: { ok: false, reason: "tts unconfigured" } },
      undefined,
    ]);
    postMessage.mockClear();
    aiChatWorkerQuiescing.current = true;
    handleSynthesizeVoice({ type: "synthesizeVoice", requestId: 2, text: "hi", tone: undefined });
    expect((await nextEvent())[0]).toEqual({ type: "voiceSynthesized", requestId: 2, result: { ok: false, reason: "worker unavailable" } });
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  test("撤回与 Worker 生命周期信号都会中止在途合成", async () => {
    const signals: AbortSignal[] = [];
    synthesizeSpeech.mockImplementation(async (request: AiSpeechRequest): Promise<null> => {
      signals.push(request.signal!);
      await new Promise<void>((resolve: () => void): void => {
        request.signal!.addEventListener("abort", (): void => resolve(), { once: true });
      });
      return null;
    });
    handleSynthesizeVoice({ type: "synthesizeVoice", requestId: 3, text: "hi", tone: undefined });
    handleCancelVoiceSynthesis({ type: "cancelVoiceSynthesis", requestId: 3 });
    expect((await nextEvent())[0]).toEqual({ type: "voiceSynthesized", requestId: 3, result: { ok: false, reason: "aborted" } });

    postMessage.mockClear();
    handleSynthesizeVoice({ type: "synthesizeVoice", requestId: 4, text: "hi", tone: undefined });
    aiChatWorkerAbortController.current.abort();
    expect((await nextEvent())[0]).toEqual({ type: "voiceSynthesized", requestId: 4, result: { ok: false, reason: "aborted" } });
    expect(signals).toHaveLength(2);
    // 未知或已结算的 requestId 撤回不做任何事。
    handleCancelVoiceSynthesis({ type: "cancelVoiceSynthesis", requestId: 99 });
  });

  test("合成意外抛错时记日志并按合成失败回执", async () => {
    synthesizeSpeech.mockImplementationOnce(async (): Promise<null> => { throw new Error("boom"); });
    handleSynthesizeVoice({ type: "synthesizeVoice", requestId: 5, text: "hi", tone: undefined });
    expect((await nextEvent())[0]).toEqual({ type: "voiceSynthesized", requestId: 5, result: { ok: false, reason: "synthesis failed" } });
    expect(loggerError.mock.calls[0]![0]).toBe("Voice synthesis for main-thread request 5 threw:");
  });
});
