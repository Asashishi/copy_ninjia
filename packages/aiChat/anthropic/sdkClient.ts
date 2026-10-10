/**
 * Anthropic SDK 客户端的构造、用量模型名与改道诊断；aiChat 实现包（aiChat/anthropic/client.ts）与 ad_detect
 * 传输层（workers/antiRaid/adDetect/ai/anthropic.ts）共用。不接触缓存，客户端由调用方按各自 owner 缓存。
 */

import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { BetaFallbackState } from "@anthropic-ai/sdk";
import { logger } from "../../infra/logger";
import { anthropicFallbackSummary } from "./response";
import type { AnthropicClient } from "../../types/aiChat/anthropic";
import type { AnthropicAgentCapabilityConfig } from "../../types/config";

/** createAnthropicClient 的 SDK 构造参数。 */
export interface AnthropicClientOptions {
  readonly timeoutMs: number;
  /** SDK 对 408/409/429/5xx 的重试次数（不含首次请求）。 */
  readonly maxRetries: number;
}

/**
 * 按能力配置构造客户端：headers 经 SDK defaultHeaders 附加到每个请求；配置了 fallback_model 时挂以它为唯一回退项的
 * betaRefusalFallbackMiddleware（默认选项：每个请求带 `fallback-credit-2026-07-01` beta，model 拒答后以 fallback_model
 * 重发同一请求并按 `best_effort` 兑换拒答带回的额度令牌，回退模型也拒答时交回该次拒答）。
 */
export function createAnthropicClient(
  config: AnthropicAgentCapabilityConfig,
  { timeoutMs, maxRetries }: AnthropicClientOptions
): AnthropicClient {
  return {
    sdk: new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      defaultHeaders: config.headers,
      timeout: timeoutMs,
      maxRetries,
      middleware: config.fallbackModel === undefined
        ? undefined
        : [betaRefusalFallbackMiddleware([{ model: config.fallbackModel }])],
    }),
    fallbackModel: config.fallbackModel,
  };
}

/** fallbackState 当前钉住的回退链下标；-1 表示请求从 model 起发。 */
export function pinnedFallbackIndex(fallbackState: BetaFallbackState): number {
  return fallbackState.index ?? -1;
}

/**
 * 用量记账的模型名：fallbackState 钉在回退项（本次拒答后回退，或会话已钉住）时取客户端配置的 fallback_model，
 * 否则取请求体的 model。两者都是部署配置里的写法，不取响应回显的规范模型 ID。
 */
export function anthropicServedModel(
  client: AnthropicClient,
  requestedModel: string,
  fallbackState: BetaFallbackState
): string {
  return pinnedFallbackIndex(fallbackState) < 0 || client.fallbackModel === undefined
    ? requestedModel
    : client.fallbackModel;
}

/** logAnthropicFallback 的入参。 */
export interface LogAnthropicFallbackOptions {
  readonly errorLabel: string;
  readonly client: AnthropicClient;
  readonly requestedModel: string;
  /** 本次调用发出前的 pinnedFallbackIndex。 */
  readonly indexBefore: number;
  readonly fallbackState: BetaFallbackState;
  /** 本次调用交回的响应；请求抛错时为 undefined。 */
  readonly message: Anthropic.Beta.BetaMessage | undefined;
}

/**
 * 本次调用改道到回退模型时记一条 warn，以 `<errorLabel> fell back after a refusal:` 开头。中间件在发回退请求前就钉住
 * fallbackState，改道按调用前后的下标判定：
 * - 回退模型产出：接 anthropicFallbackSummary 的 `from/to/trigger/fallback_credit`；
 * - 回退模型的响应不带 `fallback` 块（回退模型也拒答时 SDK 原样交回）：接 `from/to` 与回退响应的 stop_reason；
 * - 回退请求失败或超时：接 `from/to` 与 `the fallback request did not complete`。
 * 会话已钉在回退项、本次直接发给回退模型时不记。
 */
export function logAnthropicFallback({
  errorLabel,
  client,
  requestedModel,
  indexBefore,
  fallbackState,
  message,
}: LogAnthropicFallbackOptions): void {
  const summary: string | undefined = message === undefined ? undefined : anthropicFallbackSummary(message);
  if (summary !== undefined) {
    logger.warn(`${errorLabel} fell back after a refusal: ${summary}.`);
    return;
  }
  if (indexBefore >= 0 || pinnedFallbackIndex(fallbackState) < 0) return;
  const route: string = `from=${requestedModel}, to=${client.fallbackModel}`;
  logger.warn(message === undefined
    ? `${errorLabel} fell back after a refusal: ${route}; the fallback request did not complete.`
    : `${errorLabel} fell back after a refusal: ${route}; the fallback model returned stop_reason=${message.stop_reason}.`);
}
