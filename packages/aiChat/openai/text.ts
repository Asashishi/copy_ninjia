/**
 * OpenAI 侧的纯文本生成、结构化 JSON 生成、视觉描述与语音转写。文本与视觉共用 client.ts 的
 * requestOpenAiTextResult，差别只在请求体：文本走一段 user 文本，视觉改喂
 * 一份 data URI 图片；语音转写直接调 audio.transcriptions 并自行归因（见
 * transcribeOpenAiVoice）。
 *
 * 文本与视觉两条路径都显式传 instructions。
 *
 * 清洗与截断由调用方通过 normalize 传入。
 *
 * 请求体以构造器形式交给 client.ts，在它的 try 内求值（见 client.ts 的 requestOpenAiResult）。
 */

import OpenAI, { toFile } from "openai";
import type { Uploadable } from "openai";
import {
  OPENAI_JSON_MAX_TOKENS,
  OPENAI_CHAT_SUMMARY_MAX_TOKENS,
  OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS,
  OPENAI_REQUEST_TIMEOUTS_MS,
  OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS,
  OPENAI_STORE_RESPONSES,
} from "../../consts/aiChat/openai";
import { VOICE_OGG_FILE_NAME } from "../../consts/aiChat/voiceMessage";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { reportAiCacheUsage, warnAiUsageUnavailable } from "../../infra/aiCacheUsage";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import type { AiRequestFailureKind } from "../ai/utils/textResult";
import {
  classifyProviderApiFailure,
  numericErrorStatus,
} from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureKind } from "../ai/utils/mediaSupportError";
import { getOpenAiClient, requestOpenAiTextResult } from "./client";
import type {
  AiJsonRequest,
  AiTextRequest,
  AiTextResult,
  AiVisionRequest,
  AiVoiceRequest,
} from "../../types/aiChat/provider";

/** 中性总结档位的一次文本生成（冷消息压缩、贴纸整包简介）。 */
export function generateOpenAiText(request: AiTextRequest): Promise<AiTextResult> {
  return requestOpenAiTextResult({
    capability: "summary",
    buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().summary.model,
      instructions: request.systemPrompt,
      input: request.userContent,
      // 不带 temperature。
      max_output_tokens: request.purpose === "chatSummary"
        ? OPENAI_CHAT_SUMMARY_MAX_TOKENS
        : OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS,
      store: OPENAI_STORE_RESPONSES,
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
    signal: request.signal,
  });
}

/**
 * text 能力的一次结构化 JSON 生成：不挂工具，要求端点只输出 JSON 对象（`json_object`；
 * Schema 由调用方写进提示词，解码与校验也由调用方负责）。
 */
export function generateOpenAiJson(request: AiJsonRequest): Promise<AiTextResult> {
  return requestOpenAiTextResult({
    capability: "text",
    buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().text.model,
      instructions: request.systemPrompt,
      input: request.userContent,
      text: { format: { type: "json_object" } },
      max_output_tokens: OPENAI_JSON_MAX_TOKENS,
      store: OPENAI_STORE_RESPONSES,
    }),
    errorLabel: request.errorLabel,
    normalize: (text: string): string => text.trim(),
    signal: request.signal,
  });
}

/**
 * 一次视觉描述。图片以 data URI 内联进请求（字节已由
 * aiChat/ai/telegramImage.ts 下载并转码成 jpg/png），描述指令走 instructions。
 */
export function describeOpenAiVision(request: AiVisionRequest): Promise<AiTextResult> {
  return requestOpenAiTextResult({
    capability: "media",
    buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().media.model,
      instructions: request.prompt,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:${request.image.mime};base64,${request.image.bytes.toBase64()}`,
              detail: "auto",
            },
          ],
        },
      ],
      max_output_tokens: OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS,
      store: OPENAI_STORE_RESPONSES,
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
    signal: request.signal,
  });
}

function isVoiceRequestAborted(request: AiVoiceRequest): boolean {
  return request.signal?.aborted === true;
}

/**
 * 用 media 能力配置尝试 OpenAI 兼容音频转写。模型是否支持音频由第一次真实语音请求
 * 确认，结果记入媒体支持度缓存。
 */
export async function transcribeOpenAiVoice(request: AiVoiceRequest): Promise<AiTextResult> {
  if (isVoiceRequestAborted(request)) return { ok: false, retryable: false };
  try {
    const model: string = getAgentDeploymentConfig().media.model;
    const upload: Uploadable = await toFile(request.clip.bytes, VOICE_OGG_FILE_NAME, {
      type: request.clip.mime,
    });
    if (isVoiceRequestAborted(request)) return { ok: false, retryable: false };
    const requestSignal: AbortSignal = signalWithTimeout(
      request.signal,
      OPENAI_REQUEST_TIMEOUTS_MS.media
    );
    requestSignal.throwIfAborted();
    const response: OpenAI.Audio.Transcriptions.TranscriptionCreateResponse =
      await raceAbortOrThrow(
        getOpenAiClient("media").audio.transcriptions.create(
          {
            file: upload,
            model,
            prompt: request.prompt,
            response_format: "json",
          },
          { signal: requestSignal }
        ).then((result: OpenAI.Audio.Transcriptions.TranscriptionCreateResponse): OpenAI.Audio.Transcriptions.TranscriptionCreateResponse => {
          if (result.usage?.type === "duration") {
            warnAiUsageUnavailable("media", "openai", "duration");
          } else {
            reportAiCacheUsage({
              capability: "media", provider: "openai", model,
              inputTokens: result.usage?.input_tokens,
              cachedInputTokens: undefined,
              outputTokens: result.usage?.output_tokens,
            });
          }
          return result;
        }),
        requestSignal
      );
    return finalizeAiTextResult(request.normalize(response.text));
  } catch (error: unknown) {
    if (isVoiceRequestAborted(request)) return { ok: false, retryable: false };
    let failureKind: AiRequestFailureKind = "request";
    if (error instanceof OpenAI.APIError) {
      const status: number | undefined = numericErrorStatus(error);
      // APIError.message 已以 HTTP 状态码开头，此处不另加状态码。
      logger.error(`${request.errorLabel} error: ${error.message}`);
      // 归因级联与 gemini/client.ts、openai/client.ts 共用 classifyProviderApiFailure；
      // 本入口恒为媒体能力（语音转写），isMediaCapability 直接传 true，归因结果经
      // classifyAiTextFailure 映射成 AiTextResult；endpointFailure 按端点故障 request 处理。
      const providerFailure: ProviderApiFailureKind =
        classifyProviderApiFailure(status, error.message, true);
      if (providerFailure !== "endpointFailure") failureKind = providerFailure;
    } else {
      logger.error(`Error calling ${request.errorLabel}:`, error);
    }
    return classifyAiTextFailure(failureKind, "media");
  }
}
