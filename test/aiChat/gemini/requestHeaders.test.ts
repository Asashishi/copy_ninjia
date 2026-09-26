import { GEMINI_SPEECH_STYLE } from "../../../packages/consts/aiChat/gemini";
/**
 * google provider 的 base_url 与 headers 落到真实请求上：用真实 @google/genai SDK，
 * 只替换 globalThis.fetch，核对 generateContent 与 Interactions（语音合成）两条路径
 * 都发往配置的端点并带上配置的请求头，同时仍由 api_key 写出 x-goog-api-key。
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { adoptAgentDeploymentConfig } from "../../../packages/config/agent";
import { geminiClientCache } from "../../../packages/cache/workers/aiChat/gemini";
import { requestGeminiResult } from "../../../packages/aiChat/gemini/client";
import { synthesizeGeminiSpeech } from "../../../packages/aiChat/gemini/speech";
import type { GenerateContentParameters } from "@google/genai";
import type { SynthesizedSpeech } from "../../../packages/types/aiChat/voiceMessage";
import type { AgentCapabilityConfig } from "../../../packages/types/config";

const GATEWAY: string = "https://gateway.ai.cloudflare.com/v1/acc/gw/google-ai-studio";
const GATEWAY_TOKEN: string = "Bearer cf-aig-test-token";
const WAV_BYTES: Uint8Array = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
}

const captured: CapturedRequest[] = [];
const originalFetch: typeof fetch = globalThis.fetch;

function googleCapability(apiKey: string): AgentCapabilityConfig {
  return {
    provider: "google",
    apiKey,
    baseUrl: GATEWAY,
    headers: { "cf-aig-authorization": GATEWAY_TOKEN },
    model: "gemini-test",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const request: Request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  captured.push({ url: request.url, headers: request.headers });
  if (request.url.includes("/interactions")) {
    return jsonResponse({
      id: "interaction-1",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "audio", data: WAV_BYTES.toBase64(), mime_type: "audio/wav" }] }],
    });
  }
  return jsonResponse({
    candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "ok" }] } }],
  });
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  captured.length = 0;
  geminiClientCache.current = null;
  adoptAgentDeploymentConfig({
    text: googleCapability("text-key"),
    summary: googleCapability("summary-key"),
    media: googleCapability("media-key"),
    tts: { ...googleCapability("tts-key"), voice: "Leda", style: GEMINI_SPEECH_STYLE, dailyLimit: 100, dailyReserveQuota: 25 },
  });
});

describe("google provider 自定义端点与请求头", () => {
  test("generateContent 发往 base_url 并带上 headers", async () => {
    await requestGeminiResult("text", (): GenerateContentParameters => ({
      model: "gemini-test",
      contents: "hello",
    }), "Gemini header test");

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url.startsWith(`${GATEWAY}/`)).toBe(true);
    expect(captured[0]!.url).toContain(":generateContent");
    expect(captured[0]!.headers.get("cf-aig-authorization")).toBe(GATEWAY_TOKEN);
    expect(captured[0]!.headers.get("x-goog-api-key")).toBe("text-key");
  });

  test("语音合成走 Interactions，同样发往 base_url 并带上 headers", async () => {
    const speech: SynthesizedSpeech | null = await synthesizeGeminiSpeech({ text: "テスト" });

    expect(speech?.bytes).toEqual(WAV_BYTES);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url.startsWith(`${GATEWAY}/`)).toBe(true);
    expect(captured[0]!.url).toContain("/interactions");
    expect(captured[0]!.headers.get("cf-aig-authorization")).toBe(GATEWAY_TOKEN);
    expect(captured[0]!.headers.get("x-goog-api-key")).toBe("tts-key");
  });
});
