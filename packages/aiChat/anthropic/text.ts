/**
 * Anthropic 侧的纯文本生成、结构化 JSON 生成与视觉描述，共用 client.ts 的
 * requestAnthropicTextResult，差别只在请求体。语音转写不实现：Messages API 没有音频输入，
 * 契约里的 transcribeVoice 在本包缺席（见 aiChat/provider.ts 的启动诊断）。
 *
 * 清洗与截断由调用方通过 normalize 传入，口径同 aiChat/openai/text.ts。请求不带采样温度。
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_CHAT_SUMMARY_MAX_TOKENS,
  ANTHROPIC_JSON_MAX_TOKENS,
  ANTHROPIC_MEDIA_DESCRIPTION_MAX_TOKENS,
  ANTHROPIC_STICKER_PACK_SUMMARY_MAX_TOKENS,
} from "../../consts/aiChat/anthropic";
import { getAgentDeploymentConfig } from "../../config/agent";
import { requestAnthropicTextResult } from "./client";
import type {
  AiJsonRequest,
  AiTextRequest,
  AiTextResult,
  AiVisionRequest,
} from "../../types/aiChat/provider";

/** 中性总结档位的一次文本生成（冷消息压缩、贴纸整包简介）。 */
export function generateAnthropicText(request: AiTextRequest): Promise<AiTextResult> {
  return requestAnthropicTextResult({
    capability: "summary",
    buildBody: (): Anthropic.MessageCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().summary.model,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userContent }],
      max_tokens: request.purpose === "chatSummary"
        ? ANTHROPIC_CHAT_SUMMARY_MAX_TOKENS
        : ANTHROPIC_STICKER_PACK_SUMMARY_MAX_TOKENS,
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
    signal: request.signal,
  });
}

/**
 * text 能力的一次结构化 JSON 生成：不挂工具，按 `output_config.format`（json_schema）约束输出；
 * 解码与校验仍由调用方负责。
 */
export function generateAnthropicJson(request: AiJsonRequest): Promise<AiTextResult> {
  return requestAnthropicTextResult({
    capability: "text",
    buildBody: (): Anthropic.MessageCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().text.model,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userContent }],
      output_config: { format: { type: "json_schema", schema: request.jsonSchema } },
      max_tokens: ANTHROPIC_JSON_MAX_TOKENS,
    }),
    errorLabel: request.errorLabel,
    normalize: (text: string): string => text.trim(),
    signal: request.signal,
  });
}

/** 一次视觉描述：图片以 base64 内联（字节已由 aiChat/ai/telegramImage.ts 转码成 jpg/png）。 */
export function describeAnthropicVision(request: AiVisionRequest): Promise<AiTextResult> {
  return requestAnthropicTextResult({
    capability: "media",
    buildBody: (): Anthropic.MessageCreateParamsNonStreaming => ({
      model: getAgentDeploymentConfig().media.model,
      system: request.prompt,
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: { type: "base64", media_type: request.image.mime, data: request.image.bytes.toBase64() },
        }],
      }],
      max_tokens: ANTHROPIC_MEDIA_DESCRIPTION_MAX_TOKENS,
    }),
    errorLabel: request.errorLabel,
    normalize: request.normalize,
    signal: request.signal,
  });
}
