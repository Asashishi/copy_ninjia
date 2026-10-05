/**
 * Anthropic Messages API 的底层收发与响应分类。本实现包（packages/aiChat/anthropic/）的回复
 * 会话、纯文本、视觉描述、结构化 JSON 与联网检索全部经由这里发请求。
 *
 * 收发走官方 @anthropic-ai/sdk：超时与瞬时失败重试由 SDK 内建。客户端按能力缓存
 * （cache/workers/aiChat/anthropic.ts），Worker 崩溃重建后从空 holder 重新构造。
 * token 与检索次数经 infra/aiCacheUsage.ts 的 reportAnthropicUsage 按同一响应上报。
 */

import Anthropic from "@anthropic-ai/sdk";
import { anthropicClientCache } from "../../cache/workers/aiChat/anthropic";
import { capabilityClient } from "../capabilityClient";
import { logger } from "../../infra/logger";
import { reportAnthropicUsage } from "../../infra/aiCacheUsage";
import {
  ANTHROPIC_REQUEST_MAX_RETRIES,
  ANTHROPIC_REQUEST_TIMEOUTS_MS,
} from "../../consts/aiChat/anthropic";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import {
  classifyProviderApiFailure,
  numericErrorStatus,
  providerApiFailureResult,
} from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureResult } from "../ai/utils/mediaSupportError";
import { countAnthropicWebSearches, messageText } from "./response";
import type { AnthropicRequestResult } from "../../types/aiChat/anthropic";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, ProviderCapabilityConfig } from "../../types/config";

/** 按能力取得 Anthropic 客户端；每项能力的 api_key/base_url 独立。 */
function getAnthropicClient(capability: AgentCapability): Anthropic {
  return capabilityClient({
    provider: "anthropic",
    capability,
    holder: anthropicClientCache,
    create: (config: ProviderCapabilityConfig<"anthropic">): Anthropic => new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: ANTHROPIC_REQUEST_TIMEOUTS_MS[capability],
      maxRetries: ANTHROPIC_REQUEST_MAX_RETRIES,
    }),
  });
}

/** HTTP 成功但产出不可用的收尾原因；`pause_turn` 由调用方续发，不在这里判。 */
function isUnusableStopReason(message: Anthropic.Message): boolean {
  return message.stop_reason === "max_tokens" ||
    message.stop_reason === "refusal" ||
    message.stop_reason === "model_context_window_exceeded";
}

/** Anthropic Messages 调用的完整参数；能力决定客户端端点。 */
export interface AnthropicRequestOptions {
  readonly capability: AgentCapability;
  /**
   * 就地构造完整请求体（官方 SDK 的参数类型）。收构造器而不是构造好的对象：模型名与端点来自
   * config/dynamic/agent.json，配置写坏时解析会抛，必须发生在本函数的 try 内，口径同
   * aiChat/openai/client.ts 的 requestOpenAiResult。
   */
  readonly buildBody: () => Anthropic.MessageCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly signal?: AbortSignal;
}

/**
 * 调一次 Messages 接口。请求失败、超时、非 2xx 或产出不可用返回带诊断的失败结果（已记日志）；
 * `pause_turn` 按成功交回，由挂了服务端工具的调用方续发。
 */
export async function requestAnthropicMessage({
  capability,
  buildBody,
  errorLabel,
  signal,
}: AnthropicRequestOptions): Promise<AnthropicRequestResult> {
  let message: Anthropic.Message;
  try {
    signal?.throwIfAborted();
    const body: Anthropic.MessageCreateParamsNonStreaming = buildBody();
    const requestSignal: AbortSignal = signalWithTimeout(signal, ANTHROPIC_REQUEST_TIMEOUTS_MS[capability]);
    requestSignal.throwIfAborted();
    message = await raceAbortOrThrow(
      getAnthropicClient(capability).messages.create(body, { signal: requestSignal })
        .then((result: Anthropic.Message): Anthropic.Message => {
          reportAnthropicUsage({ capability, model: body.model, usage: result.usage, searchCalls: countAnthropicWebSearches(result) });
          return result;
        }),
      requestSignal
    );
  } catch (error: unknown) {
    if (signal?.aborted === true) return { ok: false, failureKind: "request" };
    if (error instanceof Anthropic.APIError) {
      logger.error(`${errorLabel} error: ${error.message}`);
      const failure: ProviderApiFailureResult | undefined = providerApiFailureResult(
        classifyProviderApiFailure(numericErrorStatus(error), error.message, capability === "media")
      );
      if (failure !== undefined) return failure;
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return { ok: false, failureKind: "request" };
  }
  if (isUnusableStopReason(message)) {
    logger.error(
      `${errorLabel} returned an unusable response: stop_reason=${message.stop_reason} ` +
      `(hasPartialText=${messageText(message).length > 0}).`
    );
    return { ok: false, failureKind: "response", stopReason: message.stop_reason ?? undefined, message };
  }
  return { ok: true, message };
}

/** Anthropic 无状态文本调用参数。 */
export interface AnthropicTextRequestOptions {
  readonly capability: "summary" | "media" | "text";
  readonly buildBody: () => Anthropic.MessageCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly normalize: (text: string) => string;
  readonly signal?: AbortSignal;
}

/**
 * 请求一段需要业务侧清洗的文本，并把跨请求重试边界显式带回调用方；口径同
 * aiChat/openai/client.ts 的 requestOpenAiTextResult。
 */
export async function requestAnthropicTextResult({
  capability,
  buildBody,
  errorLabel,
  normalize,
  signal,
}: AnthropicTextRequestOptions): Promise<AiTextResult> {
  const result: AnthropicRequestResult = await requestAnthropicMessage({ capability, buildBody, errorLabel, signal });
  if (signal?.aborted === true) return { ok: false, retryable: false };
  if (!result.ok) return classifyAiTextFailure(result.failureKind, capability);
  return finalizeAiTextResult(normalize(messageText(result.message)));
}
