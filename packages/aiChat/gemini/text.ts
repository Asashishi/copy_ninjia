/**
 * Gemini 侧的纯文本生成、结构化 JSON 生成、视觉描述与语音转写。四者共用 client.ts 的
 * requestGeminiTextResult，差别只在请求体：文本走一段 user 文本，视觉多挂一份
 * inlineData 图片字节，语音则挂一份 inlineData 音频字节。
 *
 * 视觉与语音转写共用 config/dynamic/agent.json 的 `agent.media`。
 *
 * 清洗与截断由调用方通过 normalize 传入，不在本包内决定。
 */

import {
  GEMINI_JSON_MAX_TOKENS,
  GEMINI_CHAT_SUMMARY_MAX_TOKENS,
  GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS,
  GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS,
  GEMINI_SUMMARY_TEMPERATURE,
  GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS,
} from "../../consts/aiChat/gemini";
import { getAgentDeploymentConfig } from "../../config/agent";
import { requestGeminiTextResult } from "./client";
import type { GenerateContentParameters } from "@google/genai";
import type {
  AiJsonRequest,
  AiTextRequest,
  AiTextResult,
  AiVisionRequest,
  AiVoiceRequest,
} from "../../types/aiChat/provider";

/** 中性总结档位的一次文本生成（冷消息压缩、贴纸整包简介）。 */
export function generateGeminiText(request: AiTextRequest): Promise<AiTextResult> {
  return requestGeminiTextResult({
    capability: "summary",
    buildBody: (): GenerateContentParameters => ({
      model: getAgentDeploymentConfig().summary.model,
      contents: [{ role: "user", parts: [{ text: request.userContent }] }],
      config: {
        systemInstruction: request.systemPrompt,
        abortSignal: request.signal,
        temperature: GEMINI_SUMMARY_TEMPERATURE,
        maxOutputTokens: request.purpose === "chatSummary"
          ? GEMINI_CHAT_SUMMARY_MAX_TOKENS
          : GEMINI_STICKER_PACK_SUMMARY_MAX_TOKENS,
      },
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
    signal: request.signal,
  });
}

/**
 * text 能力的一次结构化 JSON 生成：不挂工具、不引用显式缓存，按 `responseJsonSchema` 约束输出；
 * 解码与校验仍由调用方负责。
 */
export function generateGeminiJson(request: AiJsonRequest): Promise<AiTextResult> {
  return requestGeminiTextResult({
    capability: "text",
    buildBody: (): GenerateContentParameters => ({
      model: getAgentDeploymentConfig().text.model,
      contents: [{ role: "user", parts: [{ text: request.userContent }] }],
      config: {
        systemInstruction: request.systemPrompt,
        abortSignal: request.signal,
        responseMimeType: "application/json",
        responseJsonSchema: request.jsonSchema,
        maxOutputTokens: GEMINI_JSON_MAX_TOKENS,
      },
    }),
    errorLabel: request.errorLabel,
    normalize: (text: string): string => text.trim(),
    signal: request.signal,
  });
}

interface InlineMediaPrompt {
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly errorLabel: string;
  readonly signal?: AbortSignal;
  readonly normalize: AiVisionRequest["normalize"];
}

/**
 * media 档位的一次「内联媒体 + 文字指令」请求：user 轮里先放内联媒体、后放文字指令。
 * 视觉描述与语音转写共用；两者都不传 temperature，使用模型默认档。
 */
function requestInlineMediaText({
  mime,
  bytes,
  prompt,
  maxOutputTokens,
  errorLabel,
  signal,
  normalize,
}: InlineMediaPrompt): Promise<AiTextResult> {
  return requestGeminiTextResult({
    capability: "media",
    buildBody: (): GenerateContentParameters => ({
      model: getAgentDeploymentConfig().media.model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: bytes.toBase64() } },
            { text: prompt },
          ],
        },
      ],
      config: { maxOutputTokens, abortSignal: signal },
    }),
    errorLabel,
    normalize,
    signal,
  });
}

/**
 * 一次视觉描述。图片以 inlineData 直接内联进请求（字节已由
 * aiChat/ai/telegramImage.ts 下载并转码成 jpg/png）。
 */
export function describeGeminiVision(request: AiVisionRequest): Promise<AiTextResult> {
  return requestInlineMediaText({
    mime: request.image.mime,
    bytes: request.image.bytes,
    prompt: request.prompt,
    maxOutputTokens: GEMINI_MEDIA_DESCRIPTION_MAX_TOKENS,
    errorLabel: request.errorLabel,
    signal: request.signal,
    normalize: request.normalize,
  });
}

/**
 * 一次语音转写。音频以 inlineData 直接内联进请求（字节由
 * aiChat/ai/telegramAudio.ts 按原容器取回，不转码）。
 */
export function transcribeGeminiVoice(request: AiVoiceRequest): Promise<AiTextResult> {
  return requestInlineMediaText({
    mime: request.clip.mime,
    bytes: request.clip.bytes,
    prompt: request.prompt,
    maxOutputTokens: GEMINI_VOICE_TRANSCRIPTION_MAX_TOKENS,
    errorLabel: request.errorLabel,
    signal: request.signal,
    normalize: request.normalize,
  });
}
