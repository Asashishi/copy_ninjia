/**
 * Gemini generateContent 的底层收发与响应分类。本实现包（packages/aiChat/gemini/）
 * 的回复会话、文本生成、视觉描述与生图全部经由这里发请求。
 *
 * 收发走官方 @google/genai SDK（Google 现行的统一 GenAI JS SDK）而不是手写
 * fetch：SDK 自带每次请求的超时（httpOptions.timeout）与瞬时失败（网络错误/
 * 5xx/429）的自动重试（显式限制为首次加最多 5 次重试），比自己维护一份 AbortController
 * 省心。视觉输入（inlineData）与多轮函数调用往返均由同一 SDK 处理。
 *
 * 本文件负责发请求、按业务结果分类并记录错误日志；正文与函数调用直接读取
 * SDK 的 text/functionCalls 访问器，应用侧只在 aiChat/gemini/response.ts 补充
 * 异常结束诊断与搜索调用计数。
 */

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import type { Candidate, GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { geminiClientCache } from "../../cache/workers/aiChat/gemini";
import { logger } from "../../infra/logger";
import { getAgentDeploymentConfig } from "../../config/agent";
import {
  GEMINI_REQUEST_RETRY_ATTEMPTS,
  GEMINI_REQUEST_TIMEOUT_MS,
  GEMINI_SAFETY_SETTINGS,
} from "../../consts/aiChat/gemini";
import { signalWithTimeout } from "../../libs/abortSignal";
import { classifyAiTextFailure, finalizeAiTextResult } from "../ai/utils/textResult";
import {
  isEndpointFailureStatus,
  isEndpointMisconfiguredError,
  isExplicitUnsupportedMediaError,
} from "../ai/utils/mediaSupportError";
import { abnormalFinishDiagnostic } from "./response";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import type { AiTextResult } from "../../types/aiChat/provider";
import type { AgentCapability, AgentCapabilityConfig } from "../../types/config";

/**
 * 取得线程内唯一 Gemini 客户端。timeout 是每次 SDK 尝试各自的预算，重试总数
 * 由 GEMINI_REQUEST_RETRY_ATTEMPTS 显式约束。Worker 线程各自拥有独立实例，
 * 崩溃重建后由 cache/workers/aiChat/gemini.ts 的空 holder 重建。
 *
 * 导出是为了让 aiChat/gemini/song.ts 复用同一个实例：生歌走 Interactions API 那条
 * 端点，用不上下面的 generateContent 封装，但**必须**共用这一个客户端——每条流水线
 * 各 new 一个会让同一条 Worker 线程上散着好几份连接池与鉴权状态。本包之外不得
 * import 它（领域侧只认 aiChat/provider.ts 的中立契约）。
 */
export function getGeminiClient(capability: AgentCapability): GoogleGenAI {
  const config: AgentCapabilityConfig | undefined = getAgentDeploymentConfig()[capability];
  if (config?.provider !== "google") {
    throw new Error(`Agent capability "${capability}" is not configured for the Google provider.`);
  }
  const clients: Map<AgentCapability, GoogleGenAI> = geminiClientCache.current ??=
    new Map<AgentCapability, GoogleGenAI>();
  const cached: GoogleGenAI | undefined = clients.get(capability);
  if (cached !== undefined) return cached;
  const client: GoogleGenAI = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      baseUrl: config.baseUrl,
      timeout: GEMINI_REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: GEMINI_REQUEST_RETRY_ATTEMPTS },
    },
  });
  clients.set(capability, client);
  return client;
}

/**
 * 调一次 generateContent 接口。请求失败、超时、非 2xx 或异常 candidate
 * 返回带诊断的失败结果（已记日志）；finishReason=MAX_TOKENS 的静默失败（多半是输出/思考把
 * maxOutputTokens 烧光，见 consts/aiChat/gemini.ts 的 GEMINI_REPLY_MAX_TOKENS 注释）点名
 * 记下来，否则上层只能看到「没产出」，查不到原因。
 * @param buildBody 拼出完整请求体的闭包（model/contents/config 等由调用方拼好），
 *   直接使用官方 SDK 的 GenerateContentParameters，SDK 升级造成的字段漂移会在
 *   编译期暴露。收的是闭包而不是拼好的对象，因为请求体里要读 config/agent.json
 *   对应能力的模型名：在调用方的对象字面量里求值，这份
 *   部署配置一旦写坏，抛出的位置就在本函数**之外**，绕开这里唯一的失败归一化，
 *   于是上层拿不到 ok:false 而是被更外层的 catch 吞掉——回复轮次会连同排队中的
 *   其余工具调用一起静默消失。口径同 aiChat/openai/client.ts 的 requestOpenAiResult。
 * @param errorLabel 出现在错误日志里的调用名，用于区分是哪条流水线出的错。
 */
export async function requestGeminiResult(
  capability: AgentCapability,
  buildBody: () => GenerateContentParameters,
  errorLabel: string
): Promise<GeminiRequestResult> {
  // 未赋值即代表 buildBody() 自己抛了（多半是部署配置写坏），此时没有 body 可读。
  let body: GenerateContentParameters | undefined;
  let data: GenerateContentResponse;
  try {
    body = buildBody();
    data = await getGeminiClient(capability).models.generateContent({
      ...body,
      config: {
        ...body.config,
        // 在唯一底层封装覆盖，聊天、压缩、媒体描述和未来调用方不会漏配，
        // 也不能各自悄悄恢复成更严格的档位。
        safetySettings: [...GEMINI_SAFETY_SETTINGS],
        // 同上，deadline 也收在这里：SDK 的 httpOptions.timeout 是每次尝试各自
        // 的期限，乘上 GEMINI_REQUEST_RETRY_ATTEMPTS 就是分钟级。合成后的 signal
        // 一触发，SDK 的 onFailedAttempt 即短路整轮重试，最坏挂起收敛到
        // GEMINI_REQUEST_TIMEOUT_MS。调用方的 invalidate signal 仍照常贯穿。
        abortSignal: signalWithTimeout(body.config?.abortSignal, GEMINI_REQUEST_TIMEOUT_MS),
      },
    });
  } catch (error: unknown) {
    if (body?.config?.abortSignal?.aborted === true) {
      return { ok: false, failureKind: "request", diagnostic: "request aborted" };
    }
    if (error instanceof ApiError) {
      // ApiError 自带 HTTP 状态码与 API 返回的错误信息，拼一行足够定位。
      logger.error(`${errorLabel} error: ${error.status} ${error.message}`);
      // 路径级 404/405 与模态被拒是两回事，对任何能力都先判前者：它说明这条
      // 能力的 model 或 base_url 写错了，与「这个模型不支持读图」不该混在一起。
      if (isEndpointMisconfiguredError(error.status)) {
        return { ok: false, failureKind: "misconfigured", diagnostic: "endpoint or model is unavailable" };
      }
      if (
        capability === "media" &&
        isExplicitUnsupportedMediaError(error.status, error.message)
      ) {
        return { ok: false, failureKind: "unsupported", diagnostic: "media input is unsupported" };
      }
      if (!isEndpointFailureStatus(error.status)) {
        return { ok: false, failureKind: "rejected", diagnostic: "request was rejected" };
      }
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return { ok: false, failureKind: "request", diagnostic: "request failed" };
  }

  const candidate: Candidate | undefined = data.candidates?.[0];
  if (candidate?.finishReason === FinishReason.MAX_TOKENS) {
    // 被 maxOutputTokens 腰斩即便带着「已经写出半句话」的部分正文，上层照样
    // 会把这半句话当正常回复发出去，观感上就是消息突然断掉；思考型请求更
    // 容易在思考阶段就烧光额度、正文为空。不管有没有部分正文都记一条，
    // 方便观测这类「中途夭折」的频率。
    logger.error(
      `${errorLabel} response was truncated by maxOutputTokens ` +
      `(hasPartialText=${!!data.text}, ` +
      `thoughts_tokens=${data.usageMetadata?.thoughtsTokenCount ?? "?"}, ` +
      `max_output_tokens=${body?.config?.maxOutputTokens ?? "?"}).`
    );
  }

  // HTTP 层成功但内容不可用（无 candidates / SAFETY 等非 STOP 收尾）也要
  // 点名：这类响应对上层与「模型没产出」不可区分，不记就查无原因，见
  // aiChat/gemini/response.ts 的 abnormalFinishDiagnostic。
  const abnormal: string | null = abnormalFinishDiagnostic(data);
  if (abnormal) {
    logger.error(`${errorLabel} returned an unusable response: ${abnormal}.`);
    return {
      ok: false,
      failureKind: "response",
      diagnostic: abnormal,
      finishReason: candidate?.finishReason,
      finishMessage: candidate?.finishMessage,
      response: data,
    };
  }
  return { ok: true, response: data };
}

/**
 * 无需检查异常原因的调用方使用的安全便捷边界。只有正常 STOP candidate 才
 * 返回响应；任何夹带文本/functionCall 的异常 candidate 都在这里被清空。
 */
export async function requestGeminiResponse(
  capability: AgentCapability,
  buildBody: () => GenerateContentParameters,
  errorLabel: string
): Promise<GenerateContentResponse | null> {
  const result: GeminiRequestResult = await requestGeminiResult(capability, buildBody, errorLabel);
  return result.ok ? result.response : null;
}

/**
 * 请求一段需要业务侧清洗的 Gemini 文本，并把跨请求重试边界显式带回调用方。
 * HTTP/网络失败已经由 SDK 按统一次数重试，调用方不得再次发完整请求；只有
 * HTTP 成功但 candidate 异常或清洗后正文为空时，才允许按领域策略重新采样。
 */
/** Google 无状态文本调用参数。 */
export interface GeminiTextRequestOptions {
  readonly capability: "summary" | "media";
  readonly buildBody: () => GenerateContentParameters;
  readonly errorLabel: string;
  readonly normalize: (text: string) => string;
  readonly signal?: AbortSignal;
}

export async function requestGeminiTextResult({
  capability,
  buildBody,
  errorLabel,
  normalize,
  signal,
}: GeminiTextRequestOptions): Promise<AiTextResult> {
  const result: GeminiRequestResult = await requestGeminiResult(capability, buildBody, errorLabel);
  if (signal?.aborted === true) return { ok: false, retryable: false };
  if (!result.ok) return classifyAiTextFailure(result.failureKind, capability);
  const text: string = normalize(result.response.text ?? "");
  return finalizeAiTextResult(text);
}
