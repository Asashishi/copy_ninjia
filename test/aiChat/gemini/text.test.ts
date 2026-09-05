/**
 * Gemini 的纯文本生成、视觉描述与语音转写请求映射。前两项与
 * test/aiChat/openai/text.test.ts 对称：同一份中立请求，两家各自映射成自家
 * 请求体，模型由实现包自行决定、不由调用方指定。语音转写只有 Gemini 一侧有
 * （契约里是可选成员），因此没有对称用例。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GenerateContentParameters } from "@google/genai";
import type { AiTextResult } from "../../../packages/types/aiChat/provider";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";

const requestGeminiTextResult = mock(async (..._args: unknown[]): Promise<AiTextResult> => ({ ok: true, text: "ok" }));

mock.module("../../../packages/aiChat/gemini/client", () => ({ requestGeminiTextResult }));

const { describeGeminiVision, generateGeminiText, transcribeGeminiVoice } = await import("../../../packages/aiChat/gemini/text");
const {
  GEMINI_CHAT_SUMMARY_MAX_TOKENS,
  GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS,
  GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS,
  GEMINI_SUMMARY_TEMPERATURE,
  GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS,
} = await import("../../../packages/consts/aiChat/gemini");

beforeEach(() => {
  requestGeminiTextResult.mockClear();
});

describe("纯文本生成", () => {
  test("系统提示词进 systemInstruction，待处理内容进单段 user text", async () => {
    const controller: AbortController = new AbortController();
    await generateGeminiText({
      purpose: "chatSummary",
      systemPrompt: "把下面的对话压成一句话",
      userContent: "甲：你好\n乙：在",
      signal: controller.signal,
      errorLabel: "AI summarize API",
      normalize: (text: string): string => text,
    });

    const options = requestGeminiTextResult.mock.calls[0]![0] as { buildBody: () => GenerateContentParameters; errorLabel: string; signal?: AbortSignal };
    const body: GenerateContentParameters = options.buildBody();
    expect(body.model).toBe(getAgentDeploymentConfig().summary.model);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "甲：你好\n乙：在" }] }]);
    expect(body.config?.systemInstruction).toBe("把下面的对话压成一句话");
    expect(body.config?.temperature).toBe(GEMINI_SUMMARY_TEMPERATURE);
    expect(body.config?.maxOutputTokens).toBe(GEMINI_CHAT_SUMMARY_MAX_TOKENS);
    expect(options.errorLabel).toBe("AI summarize API");
    expect(body.config?.abortSignal).toBe(controller.signal);
    expect(options.signal).toBe(controller.signal);
  });

  test("贴纸整包简介走另一档 token 上限", async () => {
    await generateGeminiText({
      purpose: "stickerPackSummary",
      systemPrompt: "s",
      userContent: "u",
      errorLabel: "label",
      normalize: (text: string): string => text,
    });
    const body: GenerateContentParameters = (requestGeminiTextResult.mock.calls[0]![0] as { buildBody: () => GenerateContentParameters }).buildBody();
    expect(body.config?.maxOutputTokens).toBe(GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS);
  });

  test("清洗函数原样透传给底层，由领域侧决定截断口径", async () => {
    const normalize = (text: string): string => text.trim();
    await generateGeminiText({
      purpose: "chatSummary",
      systemPrompt: "s",
      userContent: "u",
      errorLabel: "label",
      normalize,
    });
    expect((requestGeminiTextResult.mock.calls[0]![0] as { normalize: unknown }).normalize).toBe(normalize);
  });
});

describe("视觉描述", () => {
  test("图片以 inlineData 内联，描述指令跟在图片之后", async () => {
    const bytes: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await describeGeminiVision({
      prompt: "用一句中文描述这张贴纸",
      image: { bytes, mime: "image/png" },
      errorLabel: "AI image understanding API",
      normalize: (text: string): string => text,
    });

    const body: GenerateContentParameters = (requestGeminiTextResult.mock.calls[0]![0] as { buildBody: () => GenerateContentParameters }).buildBody();
    expect(body.model).toBe(getAgentDeploymentConfig().media.model);
    expect(body.contents).toEqual([{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: bytes.toBase64() } },
        { text: "用一句中文描述这张贴纸" },
      ],
    }]);
    expect(body.config?.maxOutputTokens).toBe(GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS);
  });

  test("JPEG 走同一条路径，inlineData 的 MIME 跟随实际字节格式", async () => {
    const bytes: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    await describeGeminiVision({
      prompt: "描述",
      image: { bytes, mime: "image/jpeg" },
      errorLabel: "label",
      normalize: (text: string): string => text,
    });

    const body: GenerateContentParameters = (requestGeminiTextResult.mock.calls[0]![0] as { buildBody: () => GenerateContentParameters }).buildBody();
    const parts = (body.contents as { parts: { inlineData?: { mimeType: string } }[] }[])[0]!.parts;
    expect(parts[0]?.inlineData?.mimeType).toBe("image/jpeg");
  });
});

describe("语音转写", () => {
  test("音频以 inlineData 内联，转写指令跟在音频之后，与视觉共用 media 模型档", async () => {
    const bytes: Uint8Array = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
    await transcribeGeminiVoice({
      prompt: "把这条语音逐字转写成文字",
      clip: { bytes, mime: "audio/ogg", durationSeconds: 9 },
      errorLabel: "AI voice transcription API",
      normalize: (text: string): string => text,
    });

    const body: GenerateContentParameters = (requestGeminiTextResult.mock.calls[0]![0] as { buildBody: () => GenerateContentParameters }).buildBody();
    // 视觉与语音是同一档多模态模型的两种输入模态，不是两个模型。
    expect(body.model).toBe(getAgentDeploymentConfig().media.model);
    expect(body.contents).toEqual([{
      role: "user",
      parts: [
        { inlineData: { mimeType: "audio/ogg", data: bytes.toBase64() } },
        { text: "把这条语音逐字转写成文字" },
      ],
    }]);
    expect((requestGeminiTextResult.mock.calls[0]![0] as { errorLabel: string }).errorLabel)
      .toBe("AI voice transcription API");
  });

  test("转写档的 token 上限高于媒体描述档：逐字还原比概括长得多", async () => {
    await transcribeGeminiVoice({
      prompt: "p",
      clip: { bytes: new Uint8Array([1]), mime: "audio/ogg", durationSeconds: 1 },
      errorLabel: "label",
      normalize: (text: string): string => text,
    });

    const body: GenerateContentParameters = (requestGeminiTextResult.mock.calls[0]![0] as { buildBody: () => GenerateContentParameters }).buildBody();
    expect(body.config?.maxOutputTokens).toBe(GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS);
    expect(GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS).toBeGreaterThan(GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS);
  });

  test("不传采样温度：转写要忠实还原，随机性只会让模型润色群友的原话", async () => {
    await transcribeGeminiVoice({
      prompt: "p",
      clip: { bytes: new Uint8Array([1]), mime: "audio/ogg", durationSeconds: 1 },
      errorLabel: "label",
      normalize: (text: string): string => text,
    });

    const body: GenerateContentParameters = (requestGeminiTextResult.mock.calls[0]![0] as { buildBody: () => GenerateContentParameters }).buildBody();
    expect(body.config?.temperature).toBeUndefined();
  });
});
