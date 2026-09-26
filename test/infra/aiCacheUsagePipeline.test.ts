import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import type { GoogleGenAI } from "@google/genai";
import type OpenAI from "openai";
import { loggerStub } from "../helpers/loggerMock";
import { geminiResponse } from "../helpers/geminiResponse";
import { geminiClientCache } from "../../packages/cache/workers/aiChat/gemini";
import { openAiClientCache } from "../../packages/cache/workers/aiChat/openai";
import { adDetectOpenAiClientHolder } from "../../packages/cache/workers/antiRaid/openai";
import { adDetectGoogleClientHolder } from "../../packages/cache/workers/antiRaid/google";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import { resetAiCacheState } from "../../packages/cache/workers/diskIO/aiCache";
import { AI_CACHE_FILE_PATH, AI_CACHE_MEMORY_DIR } from "../../packages/consts/paths";
import { TEST_DATA_ROOT } from "../preloadEnv";
import { getAgentDeploymentConfig, getAdDetectAgentConfig, adoptAgentDeploymentConfig, adoptAdDetectAgentConfig } from "../../packages/config/agent";
import { parseTtsCapability } from "../../packages/config/agentCapability";
import { installAiCacheUsageSink } from "../../packages/infra/aiCacheUsage";
import { relayAiCacheUsage } from "../../packages/infra/aiCacheUsageRelay";
import { acceptDiskIODiagnosticBatch, resetDiskIODiagnosticChannel } from "../../packages/infra/diskIO/diagnosticChannel";
import { handleAntiRaidWorkerEvent } from "../../packages/antiRaid/workerBridge/events";
import { requestOpenAiAdDetectJson } from "../../packages/antiRaid/ai/openai";
import { requestGoogleAdDetectJson } from "../../packages/antiRaid/ai/google";
import { requestGeminiResponse } from "../../packages/aiChat/gemini/client";
import { generateGeminiImage } from "../../packages/aiChat/gemini/image";
import { synthesizeGeminiSpeech } from "../../packages/aiChat/gemini/speech";
import { generateOpenAiImage } from "../../packages/aiChat/openai/image";
import { transcribeOpenAiVoice } from "../../packages/aiChat/openai/text";
import { adoptAiCacheFile, inspectAiCacheFile, handleAiCacheUsageMessage, flushAiCacheBuffer, summarizeAiCache } from "../../packages/workers/diskIO/aiCacheFile";
import type { AiCacheUsage } from "../../packages/types/aiCache";
import type { AgentCapability } from "../../packages/types/config";
import type { DiskDiagnosticBatchRequest } from "../../packages/types/diskIO/messages";

const warning = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ warn: warning }) }));
const initialAgent = getAgentDeploymentConfig();
const initialAd = getAdDetectAgentConfig();

afterEach(() => {
  installAiCacheUsageSink(null);
  resetDiskIODiagnosticChannel();
  resetAiCacheState();
  diskIORuntime.initialized = false;
  diskIORuntime.writable = false;
  diskIORuntime.worker = null;
  geminiClientCache.current = null;
  openAiClientCache.current = null;
  adDetectOpenAiClientHolder.current = null;
  adDetectGoogleClientHolder.current = null;
  adoptAgentDeploymentConfig(initialAgent);
  adoptAdDetectAgentConfig(initialAd);
  rmSync(AI_CACHE_MEMORY_DIR, { recursive: true, force: true });
});

test("六种能力的真实响应适配经 Worker 转发和诊断 ACK 落盘，重建及日汇总不漏计或重复", async () => {
  expect(AI_CACHE_MEMORY_DIR.startsWith(TEST_DATA_ROOT)).toBeTrue();
  rmSync(AI_CACHE_MEMORY_DIR, { recursive: true, force: true });
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-26T03:00:00Z"));
  const deliveries: DiskDiagnosticBatchRequest[] = [];
  const worker = { postMessage(message: DiskDiagnosticBatchRequest): void {
    expect(message.type).toBe("diagnosticBatch");
    deliveries.push(structuredClone(message));
  } } as unknown as Worker;
  diskIORuntime.initialized = true;
  diskIORuntime.writable = true;
  diskIORuntime.worker = worker;
  const fromWorker = (usage: AiCacheUsage): void => {
    const event = structuredClone({ type: "aiCacheUsage", usage } as const);
    if (usage.capability === "ad_detect") handleAntiRaidWorkerEvent(event, (): void => {});
    else relayAiCacheUsage(event.usage);
  };
  const flushDeliveries = async (): Promise<void> => {
    while (deliveries.length > 0) {
      const batch = deliveries.shift()!;
      for (const message of batch.messages) {
        if (message.type !== "aiCacheUsage") throw new Error("Unexpected diagnostic");
        await handleAiCacheUsageMessage(message);
      }
      expect(await flushAiCacheBuffer()).toBeTrue();
      expect(acceptDiskIODiagnosticBatch(worker, batch.batchId)).toBeTrue();
    }
    expect(diskIORuntime.diagnosticQueue.size).toBe(0);
  };
  const google = { provider: "google", apiKey: "fixture", baseUrl: undefined, headers: undefined, model: "fixture-google" } as const;
  const openai = { provider: "openai", apiKey: "fixture", baseUrl: undefined, headers: undefined, model: "fixture-openai" } as const;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const generateContent = mock(async () => geminiResponse({
    candidates: [{ finishReason: "STOP" as any, content: { role: "model", parts: [{ text: "ok" }, { inlineData: { data: png.toBase64(), mimeType: "image/png" } }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2, cachedContentTokenCount: 4 },
  }));
  const fakeGoogle = {
    models: { generateContent },
    interactions: { create: async () => ({ output_audio: { data: new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]).toBase64(), mime_type: "audio/wav" }, usage: { total_input_tokens: 4, total_output_tokens: 8, total_thought_tokens: 1, total_cached_tokens: 1 } }) },
  } as unknown as GoogleGenAI;
  const completion = mock(async () => ({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }));
  const fakeOpenAi = {
    images: { generate: async () => ({ data: [], usage: { input_tokens: 20, output_tokens: 30 } }) },
    audio: { transcriptions: { create: async () => ({ text: "ok", usage: { type: "tokens", input_tokens: 6, output_tokens: 7 } }) } },
    chat: { completions: { create: completion } },
  } as unknown as OpenAI;
  try {
    adoptAgentDeploymentConfig({ text: google, summary: google, media: google, image: { ...google, imageProtocol: undefined },
      tts: parseTtsCapability({ provider: "google", api_key: "fixture", model: "speech", voice: "fixture" }, "fixture.json") });
    geminiClientCache.current = new Map<AgentCapability, GoogleGenAI>(["text", "summary", "media", "image", "tts"].map((capability) => [capability as AgentCapability, fakeGoogle]));
    openAiClientCache.current = new Map<AgentCapability, OpenAI>([["image", fakeOpenAi], ["media", fakeOpenAi]]);
    adoptAiCacheFile(await inspectAiCacheFile());
    installAiCacheUsageSink(fromWorker);
    for (const capability of ["text", "summary", "media"] as const) {
      expect(await requestGeminiResponse(capability, () => ({ model: google.model, contents: "fixture" }), "fixture")).not.toBeNull();
    }
    expect(await generateGeminiImage({ prompt: "fixture", aspectRatio: "1:1" })).not.toBeNull();
    expect(await synthesizeGeminiSpeech({ text: "fixture" })).not.toBeNull();
    adoptAgentDeploymentConfig({ ...getAgentDeploymentConfig(), image: { ...openai, imageProtocol: "openai" }, media: openai });
    expect(await generateOpenAiImage({ prompt: "fixture", aspectRatio: "1:1" })).toBeNull();
    expect(await transcribeOpenAiVoice({ prompt: "fixture", clip: { bytes: new TextEncoder().encode("OggS"), mime: "audio/ogg", durationSeconds: 1 }, normalize: (text: string): string => text, errorLabel: "fixture" })).toEqual({ ok: true, text: "ok" });
    const adRequest = { model: "ad-fixture", systemPrompt: "json", userContent: "fixture", temperature: 0, maxOutputTokens: 100, errorLabel: "fixture" };
    adoptAdDetectAgentConfig(openai);
    adDetectOpenAiClientHolder.current = fakeOpenAi;
    completion.mockResolvedValueOnce({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
    expect(await requestOpenAiAdDetectJson(adRequest)).toBe("{}");
    expect(completion).toHaveBeenCalledTimes(2);
    adoptAdDetectAgentConfig(google);
    adDetectGoogleClientHolder.current = fakeGoogle;
    expect(await requestGoogleAdDetectJson(adRequest)).toBe("ok");
    await flushDeliveries();
    const rows = Object.values(await Bun.file(AI_CACHE_FILE_PATH).json()) as AiCacheUsage[];
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.capability === "ad_detect")).toHaveLength(3);
    expect(new Set(rows.map((row) => row.capability))).toEqual(new Set(["text", "summary", "media", "image", "tts", "ad_detect"]));
    expect(rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(180);
    expect(rows.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(81);

    // 供应商成功但没有 usage 时仍交付正文，同时提供可区分的缺计量诊断。
    adoptAdDetectAgentConfig(openai);
    completion.mockResolvedValueOnce({ choices: [{ message: { content: "{}" } }] } as any);
    expect(await requestOpenAiAdDetectJson(adRequest)).toBe("{}");
    expect(warning.mock.calls.some((call) => String(call[0]).includes("capability=ad_detect, provider=openai, reason=missing"))).toBeTrue();

    // 重装出口与重新接管同一文件，不重放已经 ACK 的行。
    installAiCacheUsageSink(null);
    resetAiCacheState();
    adoptAiCacheFile(await inspectAiCacheFile());
    installAiCacheUsageSink(fromWorker);
    expect(await requestOpenAiAdDetectJson(adRequest)).toBe("{}");
    await flushDeliveries();
    await summarizeAiCache("2026-09-27");
    const document = await Bun.file(AI_CACHE_FILE_PATH).json();
    expect(Object.keys(document)).toEqual(["summary"]);
    expect(document.summary).toMatchObject({ day: "2026-09-26", requests: 11, inputTokens: 230, outputTokens: 86 });
    expect(document.summary.byModel["ad_detect/openai/ad-fixture"].requests).toBe(3);
  } finally {
    clock.mockRestore();
  }
});
