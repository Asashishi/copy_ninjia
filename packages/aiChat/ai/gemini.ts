/**
 * Gemini generateContent 的底层收发与响应解析。回复工具往返
 * （workers/aiChat/geminiReply.ts）、冷消息压缩（workers/aiChat/compaction.ts）、图片描述
 * （aiChat/ai/imageDescription.ts）共用。
 *
 * 收发走官方 @google/genai SDK（Google 现行的统一 GenAI JS SDK）而不是手写
 * fetch：SDK 自带每次请求的超时（httpOptions.timeout）与瞬时失败（网络错误/
 * 5xx/429）的自动重试（显式限制为最多 5 次尝试），比自己维护一份 AbortController
 * 省心。回复请求同时注册内置 googleSearch 与自定义函数，并开启
 * includeServerSideToolInvocations 让搜索记录随 content 接回；视觉输入
 * （inlineData）与多轮函数调用往返均由同一 SDK 处理。上一轮模型的完整
 * content（含 thought signature）会原样接回 contents，再附上 functionResponse，见
 * workers/aiChat/geminiReply.ts 的 callGemini）。
 *
 * 正文与函数调用直接读取 SDK 的 text/functionCalls 访问器；应用侧只在
 * aiChat/ai/utils/geminiResponse.ts 补充异常结束诊断与搜索调用计数。
 * 本文件负责发请求、按业务结果分类并记录错误日志。
 * googleSearch 是服务端工具，搜索在 Google 侧自动执行，结果直接体现在
 * 最终文本里，不会以 functionCall 形式抛回来。
 */

import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import type { Candidate, GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { geminiClientHolder } from "../../cache/workers/aiChat/gemini";
import { logger } from "../../infra/logger";
import { AI_CHAT_GEMINI_API_KEY } from "../../infra/config";
import {
  GEMINI_REQUEST_RETRY_ATTEMPTS,
  GEMINI_REQUEST_TIMEOUT_MS,
  GEMINI_SAFETY_SETTINGS,
} from "../../consts/aiChat/tools";
import { abnormalFinishDiagnostic } from "./utils/geminiResponse";
import type {
  GeminiRequestResult,
  GeminiTextGenerationResult,
} from "../../types/aiChat/gemini";

/**
 * 取得线程内唯一 Gemini 客户端。timeout 是每次 SDK 尝试各自的预算，重试总数
 * 由 GEMINI_REQUEST_RETRY_ATTEMPTS 显式约束。Worker 线程各自拥有独立实例，
 * 崩溃重建后由 cache/workers/aiChat/gemini.ts 的空 holder 重建。
 *
 * 密钥是可选 env（见 infra/config.ts）：没配时 AI Worker 根本不会启动、
 * /ai_chat enable 与投喂门禁也都把请求挡在外面（aiChat/availability.ts），
 * 走到这里说明进程启动后 env 被抽掉。这里直接抛，由下方 requestGeminiResult
 * 的 catch 记一行错并归一成一次普通的请求失败——上层各自的降级路径都已就位，
 * 不该让一次凭据缺失把整个 Worker 掀掉。
 */
function getGeminiClient(): GoogleGenAI {
  if (AI_CHAT_GEMINI_API_KEY === undefined) {
    throw new Error("AI_CHAT_GEMINI_API_KEY is not configured; AI chat cannot run.");
  }
  geminiClientHolder.current ??= new GoogleGenAI({
    apiKey: AI_CHAT_GEMINI_API_KEY,
    httpOptions: {
      timeout: GEMINI_REQUEST_TIMEOUT_MS,
      retryOptions: { attempts: GEMINI_REQUEST_RETRY_ATTEMPTS },
    },
  });
  return geminiClientHolder.current;
}

/**
 * 调一次 generateContent 接口。请求失败、超时、非 2xx 或异常 candidate
 * 返回带诊断的失败结果（已记日志）；finishReason=MAX_TOKENS 的静默失败（多半是输出/思考把
 * maxOutputTokens 烧光，见 consts/aiChat.ts 的 REPLY_MAX_TOKENS 注释）点名
 * 记下来，否则上层只能看到「没产出」，查不到原因。
 * @param body 完整请求体（model/contents/config 等由调用方拼好），直接使用
 *   官方 SDK 的 GenerateContentParameters，SDK 升级造成的字段漂移会在编译期暴露。
 * @param errorLabel 出现在错误日志里的调用名，用于区分是哪条流水线出的错。
 */
export async function requestGeminiResult(body: GenerateContentParameters, errorLabel: string): Promise<GeminiRequestResult> {
  let data: GenerateContentResponse;
  try {
    data = await getGeminiClient().models.generateContent({
      ...body,
      config: {
        ...body.config,
        // 在唯一底层封装覆盖，聊天、压缩、媒体描述和未来调用方不会漏配，
        // 也不能各自悄悄恢复成更严格的档位。
        safetySettings: [...GEMINI_SAFETY_SETTINGS],
      },
    });
  } catch (error: unknown) {
    if (body.config?.abortSignal?.aborted === true) {
      return { ok: false, failureKind: "request", diagnostic: "request aborted" };
    }
    if (error instanceof ApiError) {
      // ApiError 自带 HTTP 状态码与 API 返回的错误信息，拼一行足够定位。
      logger.error(`${errorLabel} error: ${error.status} ${error.message}`);
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
      `max_output_tokens=${body.config?.maxOutputTokens ?? "?"}).`
    );
  }

  // HTTP 层成功但内容不可用（无 candidates / SAFETY 等非 STOP 收尾）也要
  // 点名：这类响应对上层与「模型没产出」不可区分，不记就查无原因，见
  // aiChat/ai/utils/geminiResponse.ts 的 abnormalFinishDiagnostic。
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
  body: GenerateContentParameters,
  errorLabel: string
): Promise<GenerateContentResponse | null> {
  const result: GeminiRequestResult = await requestGeminiResult(body, errorLabel);
  return result.ok ? result.response : null;
}

/**
 * 请求一段需要业务侧清洗的 Gemini 文本，并把跨请求重试边界显式带回调用方。
 * HTTP/网络失败已经由 SDK 按统一次数重试，调用方不得再次发完整请求；只有
 * HTTP 成功但 candidate 异常或清洗后正文为空时，才允许按领域策略重新采样。
 */
export async function requestGeminiTextResult(
  body: GenerateContentParameters,
  errorLabel: string,
  normalize: (response: GenerateContentResponse) => string
): Promise<GeminiTextGenerationResult> {
  const result: GeminiRequestResult = await requestGeminiResult(body, errorLabel);
  if (!result.ok) {
    return { ok: false, retryable: result.failureKind === "response" };
  }
  const text: string = normalize(result.response);
  return text.length > 0
    ? { ok: true, text }
    : { ok: false, retryable: true };
}
