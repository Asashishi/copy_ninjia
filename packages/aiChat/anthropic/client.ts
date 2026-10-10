/**
 * Anthropic Messages API 的底层收发与响应分类。本实现包（packages/aiChat/anthropic/）的回复
 * 会话、纯文本、视觉描述、结构化 JSON 与联网检索全部经由这里发请求。
 *
 * 收发走官方 @anthropic-ai/sdk 的 beta Messages 端点：超时与瞬时失败重试由 SDK 内建；能力配置了
 * fallback_model 时客户端挂 betaRefusalFallbackMiddleware（默认选项：每个请求带 `fallback-credit-2026-07-01`
 * beta），model 拒答后由它以 fallback_model 重发同一请求并按 `best_effort` 兑换拒答带回的额度令牌，回退模型
 * 也拒答时交回最后那次拒答。客户端按能力缓存（cache/workers/aiChat/anthropic.ts），
 * Worker 崩溃重建后从空 holder 重新构造。token 与检索次数经 infra/aiCacheUsage.ts 的
 * reportAnthropicUsage 按同一响应上报，模型名取实际产出该响应的模型在部署配置里的写法。客户端构造、用量模型名与改道
 * 诊断见 aiChat/anthropic/sdkClient.ts。
 */

import Anthropic, { BetaFallbackState } from "@anthropic-ai/sdk";
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
import { diagnosticWithDetails } from "../ai/utils/finishDetails";
import {
  classifyProviderApiFailure,
  numericErrorStatus,
  providerApiFailureResult,
} from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureResult } from "../ai/utils/mediaSupportError";
import { anthropicStopDetailsJson, countAnthropicWebSearches, messageText } from "./response";
import { anthropicServedModel, createAnthropicClient, logAnthropicFallback, pinnedFallbackIndex } from "./sdkClient";
import type { AnthropicClient, AnthropicRequestResult } from "../../types/aiChat/anthropic";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, ProviderCapabilityConfig } from "../../types/config";

/**
 * 按能力取得 Anthropic 客户端；每项能力的 api_key/base_url/headers/fallback_model 独立（构造见
 * createAnthropicClient）。导出供本包回复会话固定客户端。
 */
export function getAnthropicClient(capability: AgentCapability): AnthropicClient {
  return capabilityClient({
    provider: "anthropic",
    capability,
    holder: anthropicClientCache,
    create: (config: ProviderCapabilityConfig<"anthropic">): AnthropicClient => createAnthropicClient(config, {
      timeoutMs: ANTHROPIC_REQUEST_TIMEOUTS_MS[capability],
      maxRetries: ANTHROPIC_REQUEST_MAX_RETRIES,
    }),
  });
}

/** HTTP 成功但产出不可用的收尾原因（拒答另判）；`pause_turn` 由调用方续发，不在这里判。 */
function isUnusableStopReason(message: Anthropic.Beta.BetaMessage): boolean {
  return message.stop_reason === "max_tokens" ||
    message.stop_reason === "model_context_window_exceeded";
}

/** Anthropic Messages 调用的完整参数；能力决定客户端端点。 */
export interface AnthropicRequestOptions {
  readonly capability: AgentCapability;
  /**
   * 就地构造完整请求体（官方 SDK 的参数类型）。构造发生在本函数的 try 内，构造抛错按请求失败处理，
   * 口径同 aiChat/openai/client.ts 的 requestOpenAiResult。
   */
  readonly buildBody: () => Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly signal?: AbortSignal;
  /** 回复会话创建时固定的客户端；缺省时在 try 内按 capability 现取（getAnthropicClient）。 */
  readonly client?: AnthropicClient;
  /**
   * 交给 betaRefusalFallbackMiddleware 的钉选状态：同一状态的后续请求从已接手的回退模型起发。回复会话与
   * 一次检索（含 `pause_turn` 续发）各持一份；缺省时本次调用新建一份。
   */
  readonly fallbackState?: BetaFallbackState;
}

/**
 * 调一次 Messages 接口。请求失败、超时、非 2xx、拒答或产出不可用返回带诊断的失败结果（已记日志，
 * 拒答与产出不可用时 `stop_details` 经 anthropicStopDetailsJson、diagnosticWithDetails 以 `details=` 一起记）；拒答
 * 归为 `refused`，调用方不得重采样。本次调用改道到回退模型时按 logAnthropicFallback 记一条 warn（含回退请求失败或
 * 超时）。`pause_turn` 按成功交回，由挂了服务端工具的调用方续发。
 */
export async function requestAnthropicMessage({
  capability,
  buildBody,
  errorLabel,
  signal,
  client,
  fallbackState = new BetaFallbackState(),
}: AnthropicRequestOptions): Promise<AnthropicRequestResult> {
  const indexBefore: number = pinnedFallbackIndex(fallbackState);
  let requestClient: AnthropicClient | undefined;
  let requestedModel: string | undefined;
  let message: Anthropic.Beta.BetaMessage;
  try {
    signal?.throwIfAborted();
    const body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = buildBody();
    const sentClient: AnthropicClient = client ?? getAnthropicClient(capability);
    requestClient = sentClient;
    requestedModel = body.model;
    const requestSignal: AbortSignal = signalWithTimeout(signal, ANTHROPIC_REQUEST_TIMEOUTS_MS[capability]);
    requestSignal.throwIfAborted();
    message = await raceAbortOrThrow(
      sentClient.sdk.beta.messages.create(body, { signal: requestSignal, fallbackState })
        .then((result: Anthropic.Beta.BetaMessage): Anthropic.Beta.BetaMessage => {
          reportAnthropicUsage({
            capability,
            model: anthropicServedModel(sentClient, body.model, fallbackState),
            usage: result.usage,
            searchCalls: countAnthropicWebSearches(result),
          });
          return result;
        }),
      requestSignal
    );
  } catch (error: unknown) {
    if (signal?.aborted === true) return { ok: false, failureKind: "request" };
    if (requestClient !== undefined && requestedModel !== undefined) {
      logAnthropicFallback({ errorLabel, client: requestClient, requestedModel, indexBefore, fallbackState, message: undefined });
    }
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
  logAnthropicFallback({ errorLabel, client: requestClient, requestedModel, indexBefore, fallbackState, message });
  const refused: boolean = message.stop_reason === "refusal";
  if (refused || isUnusableStopReason(message)) {
    const stopDetails: string | undefined = anthropicStopDetailsJson(message);
    logger.error(
      `${errorLabel} returned an unusable response: ` +
      `${diagnosticWithDetails(`model=${message.model}, stop_reason=${message.stop_reason}`, stopDetails)} ` +
      `(hasPartialText=${messageText(message).length > 0}).`
    );
    return {
      ok: false,
      failureKind: refused ? "refused" : "response",
      stopReason: message.stop_reason ?? undefined,
      stopDetails,
      message,
    };
  }
  return { ok: true, message };
}

/** Anthropic 无状态文本调用参数。 */
export interface AnthropicTextRequestOptions {
  readonly capability: "summary" | "media" | "text";
  readonly buildBody: () => Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
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
