/**
 * OpenAI Responses API 的底层收发与响应分类。本实现包（packages/aiChat/openai/）
 * 的回复会话、文本生成与视觉描述全部经由这里发请求（生图走 images 接口，
 * 见同目录 image.ts，但共用同一个客户端）。
 *
 * 走官方 openai SDK 而不是手写 fetch，理由同 Gemini 那边：超时与瞬时失败重试
 * 由 SDK 内建，不必自己维护一份 AbortController。客户端是线程内单例，Worker
 * 崩溃重建后由 cache/workers/aiChat/openai.ts 的空 holder 重新构造。
 *
 * 选 Responses 而不是 chat.completions：hosted 的 web_search 内建工具只在
 * Responses 上提供，而联网查证是本项目回复流水线的既有能力，不能丢。
 */

import OpenAI from "openai";
import { openAiClientCache } from "../../cache/workers/aiChat/openai";
import { getAgentDeploymentConfig } from "../../config/agent";
import { logger } from "../../infra/logger";
import {
  OPENAI_REQUEST_MAX_RETRIES,
  OPENAI_REQUEST_TIMEOUT_MS,
} from "../../consts/aiChat/openai";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import {
  isEndpointFailureStatus,
  isEndpointMisconfiguredError,
  isExplicitUnsupportedMediaError,
  numericErrorStatus,
} from "../ai/utils/mediaSupportError";
import {
  abnormalResponseDiagnostic,
  isTruncatedByTokenLimit,
  normalizedFinishReason,
  responseOutputText,
} from "./response";
import type { OpenAiRequestResult } from "../../types/aiChat/openai";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, AgentCapabilityConfig } from "../../types/config";

/**
 * 按能力取得 OpenAI 客户端。每项能力的 api_key/base_url 独立，避免同端点但不同
 * 凭据时复用错误的认证状态；timeout/maxRetries 是每次请求各自的预算。
 */
export function getOpenAiClient(capability: AgentCapability): OpenAI {
  const config: AgentCapabilityConfig | undefined = getAgentDeploymentConfig()[capability];
  if (config?.provider !== "openai") {
    throw new Error(`Agent capability "${capability}" is not configured for the OpenAI provider.`);
  }
  const clients: Map<AgentCapability, OpenAI> = openAiClientCache.current ??=
    new Map<AgentCapability, OpenAI>();
  const cached: OpenAI | undefined = clients.get(capability);
  if (cached !== undefined) return cached;
  const client: OpenAI = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
    maxRetries: OPENAI_REQUEST_MAX_RETRIES,
  });
  clients.set(capability, client);
  return client;
}

/** OpenAI Responses 调用的完整参数；能力决定客户端端点。 */
export interface OpenAiRequestOptions {
  readonly capability: AgentCapability;
  readonly buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly signal?: AbortSignal;
}

/**
 * 调一次 Responses 接口。请求失败、超时、非 2xx 或产出不可用返回带诊断的
 * 失败结果（已记日志）；被 max_output_tokens 腰斩的静默失败点名记下来，
 * 否则上层只能看到「没产出」，查不到原因。
 * @param buildBody 就地构造完整请求体，直接使用官方 SDK 的参数类型，SDK 升级
 *   造成的字段漂移会在编译期暴露。收的是构造器而不是构造好的对象，因为模型名
 *   与端点来自 config/agent.json 的对应能力（见 config/agent.ts），配置写坏时解析
 *   会抛：构造放在调用方就意味着异常绕过本函数的 try、直接掀掉整轮回复，上层
 *   为 `ok:false` 准备的诊断与降级路径一条都走不到，运维只看得见 bot 不说话。
 * @param errorLabel 出现在错误日志里的调用名，用于区分是哪条流水线出的错。
 * @param signal 调用方的取消信号；SDK 的请求级 signal 与 timeout 各自独立。
 */
export async function requestOpenAiResult({
  capability,
  buildBody,
  errorLabel,
  signal,
}: OpenAiRequestOptions): Promise<OpenAiRequestResult> {
  let body: OpenAI.Responses.ResponseCreateParamsNonStreaming;
  let response: OpenAI.Responses.Response;
  try {
    body = buildBody();
    response = await getOpenAiClient(capability).responses.create(body, { signal });
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      return { ok: false, failureKind: "request", diagnostic: "request aborted" };
    }
    if (error instanceof OpenAI.APIError) {
      const status: number | undefined = numericErrorStatus(error);
      // APIError 自带状态码与服务端错误信息，拼一行足够定位。
      logger.error(`${errorLabel} error: ${status ?? "?"} ${error.message}`);
      // 路径级 404/405 先判：口径同 aiChat/gemini/client.ts，写错 model 或
      // base_url 不该被记成模型缺少某项模态能力。
      if (isEndpointMisconfiguredError(status)) {
        return { ok: false, failureKind: "misconfigured", diagnostic: "endpoint or model is unavailable" };
      }
      if (
        capability === "media" &&
        isExplicitUnsupportedMediaError(status, error.message)
      ) {
        return { ok: false, failureKind: "unsupported", diagnostic: "media input is unsupported" };
      }
      if (!isEndpointFailureStatus(status)) {
        return { ok: false, failureKind: "rejected", diagnostic: "request was rejected" };
      }
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return { ok: false, failureKind: "request", diagnostic: "request failed" };
  }

  if (isTruncatedByTokenLimit(response)) {
    // 被 max_output_tokens 腰斩即便带着「已经写出半句话」的部分正文，上层照样
    // 会把这半句话当正常回复发出去，观感上就是消息突然断掉；推理型模型更容易
    // 在思考阶段就烧光额度、正文为空。不管有没有部分正文都记一条，方便观测
    // 这类「中途夭折」的频率。口径同 aiChat/gemini/client.ts 的 MAX_TOKENS 分支。
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
      diagnostic: abnormal,
      finishReason: normalizedFinishReason(response),
      response,
    };
  }
  return { ok: true, response };
}

/**
 * 请求一段需要业务侧清洗的 OpenAI 文本，并把跨请求重试边界显式带回调用方。
 * HTTP/网络失败已经由 SDK 按统一次数重试，调用方不得再次发完整请求；只有
 * HTTP 成功但产出异常或清洗后正文为空时，才允许按领域策略重新采样。
 */
/** OpenAI 无状态文本调用参数。 */
export interface OpenAiTextRequestOptions {
  readonly capability: "summary" | "media";
  readonly buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming;
  readonly errorLabel: string;
  readonly normalize: (text: string) => string;
  readonly signal?: AbortSignal;
}

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
