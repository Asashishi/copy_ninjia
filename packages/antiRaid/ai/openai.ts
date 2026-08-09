/**
 * OpenAI 兼容 chat completions 的广告检测底层收发（官方 openai SDK）。
 * 本文件只管发请求、记错误日志，不认识任何业务语义；提示词拼装与 JSON 收窄由
 * workers/antiRaid/adDetect/classifier.ts 负责。
 *
 * 超时与瞬时失败重试由 SDK 内建。客户端是 Anti-Raid Worker 的线程内单例，
 * Worker 崩溃重建后由 cache/workers/antiRaid/openai.ts 的空 holder 重建。
 */

import OpenAI from "openai";
import { adDetectOpenAiClientHolder } from "../../cache/workers/antiRaid/openai";
import { logger } from "../../infra/logger";
import { getAdDetectAgentConfig } from "../../config/agent";
import {
  AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS,
  AD_DETECT_OPENAI_REQUEST_MAX_RETRIES,
  AD_DETECT_OPENAI_REQUEST_TIMEOUT_MS,
} from "../../consts/antiRaid/adDetect";
import type { AdDetectAgentConfig } from "../../types/config";
import type { AdDetectJsonRequestParams } from "../../types/antiRaid/adDetect";

/** 取得线程内唯一 OpenAI 兼容广告检测客户端。 */
function getAdDetectOpenAiClient(): OpenAI {
  const config: AdDetectAgentConfig = getAdDetectAgentConfig();
  if (config.provider !== "openai") {
    throw new Error('Agent capability "ad_detect" is not configured for the OpenAI provider.');
  }
  adDetectOpenAiClientHolder.current ??= new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: AD_DETECT_OPENAI_REQUEST_TIMEOUT_MS,
    maxRetries: AD_DETECT_OPENAI_REQUEST_MAX_RETRIES,
  });
  return adDetectOpenAiClientHolder.current;
}

/** 一次尝试的结果；null 表示请求失败且已经记日志。 */
interface OpenAiAdDetectAttempt {
  /** 模型正文；空串表示这一轮什么都没产出。 */
  readonly body: string;
  /** 额度用尽收尾（finish_reason=length），正文多半只有半截。 */
  readonly truncated: boolean;
  readonly reasoningTokens: number | "?";
}

/** 发一次请求并收窄结果；异常就地归一成 null。 */
async function attemptOpenAiAdDetectJson({
  model,
  systemPrompt,
  userContent,
  temperature,
  maxOutputTokens,
  errorLabel,
}: AdDetectJsonRequestParams): Promise<OpenAiAdDetectAttempt | null> {
  try {
    const completion: OpenAI.Chat.Completions.ChatCompletion =
      await getAdDetectOpenAiClient().chat.completions.create({
        model,
        temperature,
        max_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      });
    const choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined = completion.choices[0];
    return {
      body: choice?.message.content ?? "",
      truncated: choice?.finish_reason === "length",
      reasoningTokens: completion.usage?.completion_tokens_details?.reasoning_tokens ?? "?",
    };
  } catch (error: unknown) {
    if (error instanceof OpenAI.APIError) {
      logger.error(`${errorLabel} failed: ${error.status ?? "?"} ${error.message}`);
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return null;
  }
}

/**
 * 发一次要求 JSON 输出的 chat completion。成功响应正文为空或被截断时按
 * AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS 有界重采样；请求异常已经由 SDK 重试过，
 * 不在业务层叠加。
 *
 * 请求固定使用 JSON object 模式，系统提示词必须明确提到 json，以满足 OpenAI 与
 * 常见兼容端点的输入约束。调用方持有完整提示词，传输层不另行拼接。
 */
export async function requestOpenAiAdDetectJson(
  params: AdDetectJsonRequestParams
): Promise<string | null> {
  for (let attempt: number = 1; attempt <= AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS; attempt++) {
    const result: OpenAiAdDetectAttempt | null = await attemptOpenAiAdDetectJson(params);
    if (result === null) return null;
    if (!result.truncated && result.body.trim().length > 0) return result.body;
    if (attempt < AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS) continue;
    logger.error(
      `${params.errorLabel} produced no usable body in ${attempt} attempt(s) ` +
      `(truncated=${result.truncated}, hasPartialText=${result.body.length > 0}, ` +
      `reasoning_tokens=${result.reasoningTokens}, max_tokens=${params.maxOutputTokens}).`
    );
  }
  return null;
}
