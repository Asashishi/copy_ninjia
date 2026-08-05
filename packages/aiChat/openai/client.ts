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
import { openAiClientHolder } from "../../cache/workers/aiChat/openai";
import { AI_CHAT_OPENAI_API_KEY } from "../../infra/config";
import { getAiAgentOpenAiConfig } from "../../config/openai";
import { logger } from "../../infra/logger";
import {
  OPENAI_REQUEST_MAX_RETRIES,
  OPENAI_REQUEST_TIMEOUT_MS,
} from "../../consts/aiChat/openai";
import { finalizeAiTextResult } from "../ai/utils/textResult";
import {
  abnormalResponseDiagnostic,
  isTruncatedByTokenLimit,
  normalizedFinishReason,
  responseOutputText,
} from "./response";
import type { OpenAiRequestResult } from "../../types/aiChat/openai";
import type { AiTextResult } from "../../types/aiChat/provider";

/**
 * 取得线程内唯一 OpenAI 客户端。timeout/maxRetries 是每次请求各自的预算。
 *
 * baseURL 来自可选的部署配置 config/openai.json 的 ai_agent.base_url：留空时走
 * SDK 默认的官方端点，配了就打自建或代理网关（见 config/openai.ts）。
 *
 * 密钥是可选 env：没配时供应商选择根本不会挑中 OpenAI（见 aiChat/provider.ts），
 * 走到这里说明进程启动后 env 被抽掉。这里直接抛，由下方 requestOpenAiResult
 * 的 catch 记一行错并归一成一次普通的请求失败——上层各自的降级路径都已就位，
 * 不该让一次凭据缺失把整个 Worker 掀掉。
 */
export function getOpenAiClient(): OpenAI {
  if (AI_CHAT_OPENAI_API_KEY === undefined) {
    throw new Error("AI_CHAT_OPENAI_API_KEY is not configured; the OpenAI provider cannot run.");
  }
  openAiClientHolder.current ??= new OpenAI({
    apiKey: AI_CHAT_OPENAI_API_KEY,
    baseURL: getAiAgentOpenAiConfig().baseUrl,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
    maxRetries: OPENAI_REQUEST_MAX_RETRIES,
  });
  return openAiClientHolder.current;
}

/**
 * 调一次 Responses 接口。请求失败、超时、非 2xx 或产出不可用返回带诊断的
 * 失败结果（已记日志）；被 max_output_tokens 腰斩的静默失败点名记下来，
 * 否则上层只能看到「没产出」，查不到原因。
 * @param buildBody 就地构造完整请求体，直接使用官方 SDK 的参数类型，SDK 升级
 *   造成的字段漂移会在编译期暴露。收的是构造器而不是构造好的对象，因为模型名
 *   与端点来自 config/openai.json（见 config/openai.ts），而那份文件写坏时解析
 *   会抛：构造放在调用方就意味着异常绕过本函数的 try、直接掀掉整轮回复，上层
 *   为 `ok:false` 准备的诊断与降级路径一条都走不到，运维只看得见 bot 不说话。
 * @param errorLabel 出现在错误日志里的调用名，用于区分是哪条流水线出的错。
 * @param signal 调用方的取消信号；SDK 的请求级 signal 与 timeout 各自独立。
 */
export async function requestOpenAiResult(
  buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming,
  errorLabel: string,
  signal?: AbortSignal
): Promise<OpenAiRequestResult> {
  let body: OpenAI.Responses.ResponseCreateParamsNonStreaming;
  let response: OpenAI.Responses.Response;
  try {
    body = buildBody();
    response = await getOpenAiClient().responses.create(body, { signal });
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      return { ok: false, failureKind: "request", diagnostic: "request aborted" };
    }
    if (error instanceof OpenAI.APIError) {
      // APIError 自带状态码与服务端错误信息，拼一行足够定位。
      logger.error(`${errorLabel} error: ${error.status ?? "?"} ${error.message}`);
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
export async function requestOpenAiTextResult(
  buildBody: () => OpenAI.Responses.ResponseCreateParamsNonStreaming,
  errorLabel: string,
  normalize: (text: string) => string
): Promise<AiTextResult> {
  const result: OpenAiRequestResult = await requestOpenAiResult(buildBody, errorLabel);
  if (!result.ok) {
    return { ok: false, retryable: result.failureKind === "response" };
  }
  const text: string = normalize(responseOutputText(result.response));
  return finalizeAiTextResult(text);
}
