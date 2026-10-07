/**
 * OpenAI Responses API 的底层收发与响应分类。本实现包（packages/aiChat/openai/）
 * 的回复会话、文本生成、结构化 JSON、视觉描述与独立检索全部经由这里发请求（生图走 images 接口，
 * 见同目录 image.ts；openai 语音协议走 audio/speech，见同目录 speech.ts；两者共用同一套
 * 按能力缓存的客户端。xai 语音协议不经 SDK，见 xaiSpeech.ts）。
 *
 * 收发走官方 openai SDK：超时与瞬时失败重试由 SDK 内建。客户端按能力缓存在线程内的 holder 里，
 * Worker 崩溃重建后由 cache/workers/aiChat/openai.ts 的空 holder 重新构造。
 * token 与检索次数经 infra/aiCacheUsage.ts 按同一响应上报。
 *
 * 使用 Responses API，联网检索挂 hosted 的 web_search 内建工具。
 */

import OpenAI from "openai";
import { openAiClientCache } from "../../cache/workers/aiChat/openai";
import { capabilityClient } from "../capabilityClient";
import { logger } from "../../infra/logger";
import { reportAiCacheUsage } from "../../infra/aiCacheUsage";
import {
  OPENAI_REQUEST_MAX_RETRIES,
  OPENAI_REQUEST_TIMEOUTS_MS,
} from "../../consts/aiChat/openai";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import {
  classifyProviderApiFailure,
  numericErrorStatus,
  providerApiFailureResult,
} from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureResult } from "../ai/utils/mediaSupportError";
import {
  abnormalResponseDiagnostic,
  countWebSearchCalls,
  isTruncatedByTokenLimit,
  normalizedFinishReason,
  responseOutputText,
} from "./response";
import type { OpenAiRequestResult } from "../../types/aiChat/openai";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, ProviderCapabilityConfig } from "../../types/config";

/**
 * 按能力取得 OpenAI 客户端。每项能力的 api_key/base_url 独立，各持一个客户端；
 * timeout/maxRetries 是每次请求各自的预算。
 */
export function getOpenAiClient(capability: AgentCapability): OpenAI {
  return capabilityClient({
    provider: "openai",
    capability,
    holder: openAiClientCache,
    create: (config: ProviderCapabilityConfig<"openai">): OpenAI => new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: OPENAI_REQUEST_TIMEOUTS_MS[capability],
      maxRetries: OPENAI_REQUEST_MAX_RETRIES,
    }),
  });
}

/**
 * Responses 用量里命中缓存的输入 token：官方字段是 `input_tokens_details.cached_tokens`；
 * DeepSeek 等兼容端点缺它时读 `prompt_cache_hit_tokens`。都没有时为 undefined。
 */
function responsesCachedTokens(usage: OpenAI.Responses.ResponseUsage | undefined): unknown {
  if (usage === undefined) return undefined;
  const cached: unknown = (usage.input_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens;
  if (cached !== undefined) return cached;
  return (usage as unknown as Readonly<Record<string, unknown>>).prompt_cache_hit_tokens;
}

/** OpenAI Responses 调用的完整参数；能力决定客户端端点。 */
export interface OpenAiRequestOptions {
  readonly capability: AgentCapability;
  readonly buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly signal?: AbortSignal;
  /** 回复会话创建时固定的客户端；缺省时在 try 内按 capability 现取（getOpenAiClient）。 */
  readonly client?: OpenAI;
}

/**
 * 调一次 Responses 接口。请求失败、超时、非 2xx 或产出不可用返回带诊断的
 * 失败结果（已记日志）；被 max_output_tokens 截断的响应另记一条 token 诊断日志。
 * @param buildBody 就地构造完整请求体，直接使用官方 SDK 的参数类型。构造发生在本函数的
 *   try 内，抛错（如 config/dynamic/agent.json 缺对应能力，见 config/agent.ts）按
 *   `failureKind: "request"` 归一。
 * @param errorLabel 出现在错误日志里的调用名。
 * @param signal 调用方的取消信号；与本函数合成的 deadline 一起下传，中止时
 *   同步阻止后续请求并结束调用方的等待。
 */
export async function requestOpenAiResult({
  capability,
  buildBody,
  errorLabel,
  signal,
  client,
}: OpenAiRequestOptions): Promise<OpenAiRequestResult> {
  let body: OpenAI.Responses.ResponseCreateParamsNonStreaming;
  let response: OpenAI.Responses.Response;
  try {
    signal?.throwIfAborted();
    body = buildBody();
    // SDK 的 timeout 是每次尝试各自的期限；同一份合成 signal 同时交给
    // SDK 与外层等待：网络层据此停止后续尝试，调用方在整轮 deadline
    // 到期或上游取消时立即结算。
    const requestSignal: AbortSignal = signalWithTimeout(signal, OPENAI_REQUEST_TIMEOUTS_MS[capability]);
    requestSignal.throwIfAborted();
    const model: string = String(body.model);
    response = await raceAbortOrThrow(
      (client ?? getOpenAiClient(capability)).responses.create(body, { signal: requestSignal })
        .then((result: OpenAI.Responses.Response): OpenAI.Responses.Response => {
          reportAiCacheUsage({
            capability, provider: "openai", model,
            inputTokens: result.usage?.input_tokens,
            cachedInputTokens: responsesCachedTokens(result.usage),
            outputTokens: result.usage?.output_tokens,
            searchCalls: countWebSearchCalls(result),
          });
          return result;
        }),
      requestSignal
    );
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      return { ok: false, failureKind: "request" };
    }
    if (error instanceof OpenAI.APIError) {
      const status: number | undefined = numericErrorStatus(error);
      // APIError.message 已以 HTTP 状态码开头并带服务端错误信息，此处原样记一行。
      logger.error(`${errorLabel} error: ${error.message}`);
      // 归因级联与失败结果映射都与 aiChat/gemini/client.ts 共用
      // ai/utils/mediaSupportError.ts 的同一份实现；undefined 是 endpointFailure
      // 那一档，落到下面的统一兜底。
      const failure: ProviderApiFailureResult | undefined = providerApiFailureResult(
        classifyProviderApiFailure(status, error.message, capability === "media")
      );
      if (failure !== undefined) return failure;
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return { ok: false, failureKind: "request" };
  }

  if (isTruncatedByTokenLimit(response)) {
    // 带 `status: "incomplete"` 的截断响应由下面的 abnormalResponseDiagnostic 判为不可用，
    // 带部分正文也整份丢弃；此处额外记一条 token 诊断，口径同
    // aiChat/gemini/client.ts 的 MAX_TOKENS 分支。
    logger.error(
      `${errorLabel} response was truncated by max_output_tokens ` +
      `(hasPartialText=${responseOutputText(response).length > 0}, ` +
      `reasoning_tokens=${response.usage?.output_tokens_details?.reasoning_tokens ?? "?"}, ` +
      `max_output_tokens=${body.max_output_tokens ?? "?"}).`
    );
  }

  const abnormal: string | null = abnormalResponseDiagnostic(response);
  if (abnormal) {
    logger.error(`${errorLabel} returned an unusable response: ${abnormal}.`);
    return {
      ok: false,
      failureKind: "response",
      finishReason: normalizedFinishReason(response),
      response,
    };
  }
  return { ok: true, response };
}

/** OpenAI 无状态文本调用参数。 */
export interface OpenAiTextRequestOptions {
  readonly capability: "summary" | "media" | "text";
  readonly buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly normalize: (text: string) => string;
  readonly signal?: AbortSignal;
}

/**
 * 请求一段需要业务侧清洗的 OpenAI 文本，并把跨请求重试边界显式带回调用方。
 * HTTP/网络失败已经由 SDK 重试，调用方不得再次发完整请求；只有
 * HTTP 成功但产出异常或清洗后正文为空时，才允许按领域策略重新采样。
 */
export async function requestOpenAiTextResult({
  capability,
  buildBody,
  errorLabel,
  normalize,
  signal,
}: OpenAiTextRequestOptions): Promise<AiTextResult> {
  const result: OpenAiRequestResult = await requestOpenAiResult({
    capability,
    buildBody,
    errorLabel,
    signal,
  });
  // 主动取消不是供应商故障，媒体能力状态机不得把它记作瞬时失败。
  if (signal?.aborted === true) return { ok: false, retryable: false };
  if (!result.ok) return classifyAiTextFailure(result.failureKind, capability);
  const text: string = normalize(responseOutputText(result.response));
  return finalizeAiTextResult(text);
}
