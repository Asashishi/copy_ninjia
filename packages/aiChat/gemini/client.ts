/**
 * Gemini generateContent 的底层收发与响应分类。本实现包（packages/aiChat/gemini/）
 * 的回复会话、文本生成、结构化 JSON、视觉描述、生图与独立检索全部经由这里发请求。
 *
 * 收发走官方 @google/genai SDK：SDK 自带每次请求的超时（httpOptions.timeout）与
 * 瞬时失败（网络错误/5xx/429）的自动重试（次数由 GEMINI_REQUEST_RETRY_ATTEMPTS 约束）。
 * 视觉输入（inlineData）与多轮函数调用往返均由同一 SDK 处理。
 *
 * 本文件负责发请求、按业务结果分类并记录错误日志；函数调用直接读取
 * SDK 的 functionCalls 访问器；正文按 SDK 的文本拼接语义由 aiChat/gemini/response.ts
 * 读取，该模块同时提供异常结束诊断、收尾详情与搜索调用计数。
 * token 与检索次数经 infra/aiCacheUsage.ts 按同一响应上报。
 */

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import type { Candidate, GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { geminiClientCache } from "../../cache/workers/aiChat/gemini";
import { logger } from "../../infra/logger";
import { reportGeminiUsage } from "../../infra/aiCacheUsage";
import { capabilityClient } from "../capabilityClient";
import {
  GEMINI_REQUEST_RETRY_ATTEMPTS,
  GEMINI_REQUEST_TIMEOUTS_MS,
  GEMINI_SAFETY_SETTINGS,
} from "../../consts/aiChat/gemini";
import { raceAbortOrThrow, signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import { diagnosticWithDetails } from "../ai/utils/finishDetails";
import {
  classifyProviderApiFailure,
  providerApiFailureResult,
} from "../ai/utils/mediaSupportError";
import type { ProviderApiFailureResult } from "../ai/utils/mediaSupportError";
import { abnormalFinishDiagnostic, countGoogleSearchCalls, geminiFinishDetails, responseText } from "./response";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, ProviderCapabilityConfig } from "../../types/config";

/**
 * 按能力取得本线程的 Gemini 客户端。timeout 是每次 SDK 尝试各自的预算，重试总数
 * 由 GEMINI_REQUEST_RETRY_ATTEMPTS 约束。Worker 线程各自拥有独立实例，
 * 崩溃重建后由 cache/workers/aiChat/gemini.ts 的空 holder 重建。
 *
 * 导出供本包内的 speech.ts（语音合成走 Interactions API 端点）、contextCache.ts
 * （显式缓存登记表）与 replySession.ts（会话创建时固定客户端）复用同一个实例。
 * 本包之外不得 import 它（领域侧只认 aiChat/provider.ts 的中立契约）。
 */
export function getGeminiClient(capability: AgentCapability): GoogleGenAI {
  return capabilityClient({
    provider: "google",
    capability,
    holder: geminiClientCache,
    create: (config: ProviderCapabilityConfig<"google">): GoogleGenAI => new GoogleGenAI({
      apiKey: config.apiKey,
      httpOptions: {
        baseUrl: config.baseUrl,
        headers: config.headers,
        timeout: GEMINI_REQUEST_TIMEOUTS_MS[capability],
        retryOptions: { attempts: GEMINI_REQUEST_RETRY_ATTEMPTS },
      },
    }),
  });
}

/** generateContent 调用的完整参数；能力决定客户端端点与超时。 */
export interface GeminiRequestOptions {
  readonly capability: AgentCapability;
  /**
   * 拼出完整请求体的闭包（model/contents/config 等由调用方拼好），直接使用官方 SDK 的
   * GenerateContentParameters。闭包在 requestGeminiResult 的 try 内求值，抛错（如
   * config/dynamic/agent.json 缺对应能力的模型名）按 `failureKind: "request"` 归一。
   * 口径同 aiChat/openai/client.ts 的 requestOpenAiResult。
   */
  readonly buildBody: () => GenerateContentParameters;
  /** 出现在错误日志里的调用名。 */
  readonly errorLabel: string;
  /** 回复会话创建时固定的客户端；缺省时在 try 内按 capability 现取（getGeminiClient）。 */
  readonly client?: GoogleGenAI;
}

/**
 * 调一次 generateContent 接口。请求失败、超时、非 2xx 或异常 candidate
 * 返回带诊断的失败结果（已记日志，异常 candidate 连同收尾详情一起记）；finishReason=MAX_TOKENS
 * 的失败另记一条带 token 诊断的日志（见 consts/aiChat/gemini.ts 的 GEMINI_REPLY_MAX_TOKENS 注释）。
 */
export async function requestGeminiResult({
  capability,
  buildBody,
  errorLabel,
  client,
}: GeminiRequestOptions): Promise<GeminiRequestResult> {
  // body 未赋值表示 buildBody() 自己抛错，此时没有 body 可读。
  let body: GenerateContentParameters | undefined;
  let data: GenerateContentResponse;
  try {
    body = buildBody();
    body.config?.abortSignal?.throwIfAborted();
    const requestSignal: AbortSignal = signalWithTimeout(
      body.config?.abortSignal,
      GEMINI_REQUEST_TIMEOUTS_MS[capability]
    );
    requestSignal.throwIfAborted();
    const model: string = String(body.model);
    data = await raceAbortOrThrow((client ?? getGeminiClient(capability)).models.generateContent({
      ...body,
      config: {
        ...body.config,
        // 安全设置在这一处统一覆盖，调用方传入的 safetySettings 不生效。
        safetySettings: [...GEMINI_SAFETY_SETTINGS],
        // SDK 与外层等待共用同一份整轮 deadline：网络层据此停止后续
        // 尝试，调用方在到期或 invalidate 时立即结算。
        abortSignal: requestSignal,
      },
    }).then((response: GenerateContentResponse): GenerateContentResponse => {
      reportGeminiUsage({ capability, model, usage: response.usageMetadata, searchCalls: countGoogleSearchCalls(response) });
      return response;
    }), requestSignal);
  } catch (error: unknown) {
    if (body?.config?.abortSignal?.aborted === true) {
      return { ok: false, failureKind: "request" };
    }
    if (error instanceof ApiError) {
      // ApiError 自带 HTTP 状态码与 API 返回的错误信息，拼一行足够定位。
      logger.error(`${errorLabel} error: ${error.status} ${error.message}`);
      // 归因级联与到失败结果的映射在 ai/utils/mediaSupportError.ts，各模型客户端共用；
      // undefined 即 endpointFailure 档，落到下面的统一兜底。
      const failure: ProviderApiFailureResult | undefined = providerApiFailureResult(
        classifyProviderApiFailure(error.status, error.message, capability === "media")
      );
      if (failure !== undefined) return failure;
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return { ok: false, failureKind: "request" };
  }

  const candidate: Candidate | undefined = data.candidates?.[0];
  if (candidate?.finishReason === FinishReason.MAX_TOKENS) {
    // MAX_TOKENS 由下面的 abnormalFinishDiagnostic 判为不可用响应，带部分正文也整份丢弃；
    // 此处额外记一条 token 诊断。
    logger.error(
      `${errorLabel} response was truncated by maxOutputTokens ` +
      `(hasPartialText=${!!responseText(data)}, ` +
      `thoughts_tokens=${data.usageMetadata?.thoughtsTokenCount ?? "?"}, ` +
      `max_output_tokens=${body?.config?.maxOutputTokens ?? "?"}).`
    );
  }

  // HTTP 层成功但内容不可用（无 candidates / SAFETY 等非 STOP 收尾）连同收尾详情记日志并按 response
  // 失败交回，见 aiChat/gemini/response.ts 的 abnormalFinishDiagnostic 与 geminiFinishDetails。
  const abnormal: string | null = abnormalFinishDiagnostic(data);
  if (abnormal) {
    const finishDetails: string | undefined = geminiFinishDetails(data);
    logger.error(`${errorLabel} returned an unusable response: ${diagnosticWithDetails(abnormal, finishDetails)}.`);
    return {
      ok: false,
      failureKind: "response",
      finishReason: candidate?.finishReason,
      finishDetails,
      response: data,
    };
  }
  return { ok: true, response: data };
}

/** Google 无状态文本调用参数。 */
export interface GeminiTextRequestOptions {
  readonly capability: "summary" | "media" | "text";
  readonly buildBody: () => GenerateContentParameters;
  readonly errorLabel: string;
  readonly normalize: (text: string) => string;
  readonly signal?: AbortSignal;
}

/**
 * 请求一段需要业务侧清洗的 Gemini 文本，并把跨请求重试边界显式带回调用方。
 * HTTP/网络失败已经由 SDK 重试，调用方不得再次发完整请求；只有
 * HTTP 成功但 candidate 异常或清洗后正文为空时，才允许按领域策略重新采样。
 */
export async function requestGeminiTextResult({
  capability,
  buildBody,
  errorLabel,
  normalize,
  signal,
}: GeminiTextRequestOptions): Promise<AiTextResult> {
  const result: GeminiRequestResult = await requestGeminiResult({ capability, buildBody, errorLabel });
  if (signal?.aborted === true) return { ok: false, retryable: false };
  if (!result.ok) {
    return classifyAiTextFailure(result.failureKind, capability);
  }
  const text: string = normalize(responseText(result.response) ?? "");
  return finalizeAiTextResult(text);
}
