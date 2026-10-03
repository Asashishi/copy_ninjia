/**
 * Anthropic Messages 的广告检测底层收发（官方 @anthropic-ai/sdk）。本文件只管发请求、记错误日志，
 * 不认识任何业务语义；提示词拼装与 JSON 收窄由 workers/antiRaid/adDetect/classifier.ts 负责。
 *
 * 系统提示词拆成两块：判定规则与部署示例（params.instructions）在前、带缓存断点，系统事实一行在后；
 * 输出按 `output_config.format`（json_schema）约束成 `{ ad, reason }`。请求不带采样温度。超时与瞬时
 * 失败重试由 SDK 内建；客户端是 Anti-Raid Worker 的线程内单例，Worker 崩溃重建后由
 * cache/workers/antiRaid/anthropic.ts 的空 holder 重建。
 */

import Anthropic from "@anthropic-ai/sdk";
import { adDetectAnthropicClientHolder } from "../../../../cache/workers/antiRaid/anthropic";
import { logger } from "../../../../infra/logger";
import { reportAnthropicUsage } from "../../../../infra/aiCacheUsage";
import { getAdDetectAgentConfig } from "../../../../config/agent";
import {
  AD_DETECT_ANTHROPIC_REQUEST_MAX_RETRIES,
  AD_DETECT_ANTHROPIC_REQUEST_TIMEOUT_MS,
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
  AD_DETECT_JSON_SCHEMA,
} from "../../../../consts/antiRaid/adDetect";
import type { AdDetectAgentConfig } from "../../../../types/config";
import type { AdDetectJsonRequestParams } from "../../../../types/antiRaid/adDetect";

/** 取得线程内唯一 Anthropic 广告检测客户端。 */
function getAdDetectAnthropicClient(): Anthropic {
  const config: AdDetectAgentConfig = getAdDetectAgentConfig();
  if (config.provider !== "anthropic") {
    throw new Error('Agent capability "ad_detect" is not configured for the Anthropic provider.');
  }
  adDetectAnthropicClientHolder.current ??= new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: AD_DETECT_ANTHROPIC_REQUEST_TIMEOUT_MS,
    maxRetries: AD_DETECT_ANTHROPIC_REQUEST_MAX_RETRIES,
  });
  return adDetectAnthropicClientHolder.current;
}

/** 一次尝试的结果；null 表示请求失败且已经记日志。 */
interface AnthropicAdDetectAttempt {
  /** 模型正文；空串表示这一轮什么都没产出。 */
  readonly body: string;
  /** 额度用尽、上下文超长或拒答收尾，正文不可用。 */
  readonly unusable: boolean;
  readonly stopReason: string;
}

/** 发一次请求并收窄结果；异常就地归一成 null。 */
async function attemptAnthropicAdDetectJson({
  model,
  instructions,
  fact,
  userContent,
  maxOutputTokens,
  errorLabel,
}: AdDetectJsonRequestParams): Promise<AnthropicAdDetectAttempt | null> {
  try {
    const message: Anthropic.Message = await getAdDetectAnthropicClient().messages.create({
      model,
      max_tokens: maxOutputTokens,
      system: [
        { type: "text", text: instructions, cache_control: { type: "ephemeral" } },
        { type: "text", text: fact },
      ],
      messages: [{ role: "user", content: userContent }],
      output_config: {
        format: {
          type: "json_schema",
          schema: AD_DETECT_JSON_SCHEMA,
        },
      },
    });
    reportAnthropicUsage({ capability: "ad_detect", model, usage: message.usage });
    let body: string = "";
    for (const block of message.content) {
      if (block.type === "text") body += block.text;
    }
    return {
      body,
      unusable: message.stop_reason === "max_tokens" || message.stop_reason === "refusal" ||
        message.stop_reason === "model_context_window_exceeded",
      stopReason: message.stop_reason ?? "?",
    };
  } catch (error: unknown) {
    if (error instanceof Anthropic.APIError) {
      logger.error(`${errorLabel} failed: ${error.message}`);
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return null;
  }
}

/**
 * 发一次要求 JSON 输出的 Messages 请求。成功响应正文为空、被截断、上下文超长或拒答时按
 * AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS 有界重采样；请求异常已经由 SDK 重试过，不在业务层叠加。
 */
export async function requestAnthropicAdDetectJson(
  params: AdDetectJsonRequestParams
): Promise<string | null> {
  for (let attempt: number = 1; attempt <= AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS; attempt++) {
    const result: AnthropicAdDetectAttempt | null = await attemptAnthropicAdDetectJson(params);
    if (result === null) return null;
    if (!result.unusable && result.body.trim().length > 0) return result.body;
    if (attempt < AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS) continue;
    logger.error(
      `${params.errorLabel} produced no usable body in ${attempt} attempt(s) ` +
      `(stop_reason=${result.stopReason}, hasPartialText=${result.body.length > 0}, max_tokens=${params.maxOutputTokens}).`
    );
  }
  return null;
}
