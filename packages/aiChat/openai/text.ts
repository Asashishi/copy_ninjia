/**
 * OpenAI 侧的纯文本生成与视觉描述。两者共用 client.ts 的
 * requestOpenAiTextResult，差别只在请求体：文本走一段 user 文本，视觉改喂
 * 一份 data URI 图片。
 *
 * 两条路径都必须显式传 instructions：不给系统提示词时，部分代理网关会把
 * 自己的默认提示词灌进去，产出的文风与长度全不受本项目控制。
 *
 * 清洗与截断由调用方通过 normalize 传入——摘要、贴纸整包简介、三类媒体描述
 * 的字数上限各不相同，那是领域策略，不该下沉到供应商实现包。
 *
 * 请求体以构造器形式交给 client.ts，让 config/agent.json 的解析发生在它的
 * try 内（理由见 client.ts 的 requestOpenAiResult）。
 */

import OpenAI, { toFile } from "openai";
import type { Uploadable } from "openai";
import {
  OPENAI_CHAT_SUMMARY_MAX_TOKENS,
  OPENAI_MEDIA_DESCRIPTION_MAX_TOKENS,
  OPENAI_STICKER_PACK_SUMMARY_MAX_TOKENS,
  OPENAI_STORE_RESPONSES,
} from "../../consts/aiChat/openai";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import { finalizeAiTextResult } from "../ai/utils/textResult";
import {
  isEndpointFailureStatus,
  isEndpointMisconfiguredError,
  isExplicitUnsupportedMediaError,
  numericErrorStatus,
} from "../ai/utils/mediaSupportError";
import { getOpenAiClient, requestOpenAiTextResult } from "./client";
import type {
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
      // 不带 temperature：摘要用低温这条策略在 GPT-5 系推理模型上不可用。
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
 * 一次视觉描述。图片以 data URI 内联进请求（字节已由
 * aiChat/ai/telegramImage.ts 下载并转码成 jpg/png），描述指令走 instructions
 * ——Responses 的图片输入不接受与图片并列的系统级指令，放 instructions 才是
 * 这套 API 的惯用位置。
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

/**
 * 用 media 能力配置尝试 OpenAI 兼容音频转写。模型是否同时支持视觉与音频不靠
 * 名字推断：第一次真实语音请求由端点回答，结果会被媒体支持度缓存记住。
 */
function isVoiceRequestAborted(request: AiVoiceRequest): boolean {
  return request.signal?.aborted === true;
}

export async function transcribeOpenAiVoice(request: AiVoiceRequest): Promise<AiTextResult> {
  if (isVoiceRequestAborted(request)) return { ok: false, retryable: false };
  try {
    const model: string = getAgentDeploymentConfig().media.model;
    const upload: Uploadable = await toFile(request.clip.bytes, "voice.ogg", {
      type: request.clip.mime,
    });
    const response: OpenAI.Audio.Transcriptions.TranscriptionCreateResponse =
      await getOpenAiClient("media").audio.transcriptions.create(
        {
          file: upload,
          model,
          prompt: request.prompt,
          response_format: "json",
        },
        { signal: request.signal }
      );
    return finalizeAiTextResult(request.normalize(response.text));
  } catch (error: unknown) {
    if (isVoiceRequestAborted(request)) return { ok: false, retryable: false };
    if (error instanceof OpenAI.APIError) {
      const status: number | undefined = numericErrorStatus(error);
      logger.error(`${request.errorLabel} error: ${status ?? "?"} ${error.message}`);
      // 归因口径与 aiChat/openai/client.ts 一致：路径级 404/405 是配置错误，
      // 正文明确拒绝模态才是能力缺失，其余按瞬时故障交给探测退避。
      if (isEndpointMisconfiguredError(status)) {
        return { ok: false, retryable: false, mediaFailure: "misconfigured" };
      }
      if (isExplicitUnsupportedMediaError(status, error.message)) {
        return { ok: false, retryable: false, mediaFailure: "unsupported" };
      }
      // 普通 4xx 只说明这一份音频不合适：不下模态结论，也不推动退避。
      if (!isEndpointFailureStatus(status)) return { ok: false, retryable: false };
    } else {
      logger.error(`Error calling ${request.errorLabel}:`, error);
    }
    return { ok: false, retryable: false, mediaFailure: "transient" };
  }
}
