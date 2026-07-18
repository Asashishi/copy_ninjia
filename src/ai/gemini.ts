/**
 * Gemini generateContent 的底层收发与响应解析。回复流水线（workers/aiChatWorker.ts
 * 的工具往返循环）、冷消息压缩（summarizeBatch）、图片描述
 * （ai/imageDescription.ts）共用。
 *
 * 收发走官方 @google/genai SDK（Google 现行的统一 GenAI JS SDK）而不是手写
 * fetch：SDK 自带每次请求的超时（httpOptions.timeout）与瞬时失败（网络错误/
 * 5xx/429）的自动重试（默认最多 5 次尝试），比自己维护一份 AbortController
 * 省心。回复请求同时注册内置 googleSearch 与自定义函数，并开启
 * includeServerSideToolInvocations 让搜索记录随 content 接回；视觉输入
 * （inlineData）与多轮函数调用往返均由同一 SDK 处理。上一轮模型的完整
 * content（含 thought signature）会原样接回 contents，再附上 functionResponse，见
 * workers/aiChatWorker.ts 的 callGemini）。
 *
 * 响应形状的结构性解析（取正文/函数调用/是否被 token 上限腰斩）是纯函数，
 * 抽在 ai/utils/geminiResponse.ts；本文件只管发请求、记错误日志。
 * googleSearch 是服务端工具，搜索在 Google 侧自动执行，结果直接体现在
 * 最终文本里，不会以 functionCall 形式抛回来。
 */

import { ApiError, GoogleGenAI } from "@google/genai";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { logger } from "../infra/logger";
import { GEMINI_API_KEY } from "../infra/config";
import { GEMINI_REQUEST_TIMEOUT_MS } from "../consts/aiChat";
import { extractOutputText, isTruncatedByTokenLimit } from "./utils/geminiResponse";

/** 进程内唯一的 Gemini 客户端实例（timeout 是每次请求/每次重试各自的预算，
 *  不是所有重试共享一个硬顶，见 consts/aiChat.ts 的 GEMINI_REQUEST_TIMEOUT_MS 注释）。
 *  Worker 线程各自 import 本文件会各自拿到一份独立实例，符合现状——本来
 *  就没有跨线程共享 Gemini 调用状态的需求。 */
const client: GoogleGenAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { timeout: GEMINI_REQUEST_TIMEOUT_MS } });

/**
 * 调一次 generateContent 接口。请求失败、超时或非 2xx 时返回 null（已记
 * 日志）；finishReason=MAX_TOKENS 的静默失败（多半是输出/思考把
 * maxOutputTokens 烧光，见 consts/aiChat.ts 的 REPLY_MAX_TOKENS 注释）点名
 * 记下来，否则上层只能看到「没产出」，查不到原因。
 * @param body 完整请求体（model/contents/config 等由调用方拼好），直接使用
 *   官方 SDK 的 GenerateContentParameters，SDK 升级造成的字段漂移会在编译期暴露。
 * @param errorLabel 出现在错误日志里的调用名，用于区分是哪条流水线出的错。
 */
export async function requestGeminiResponse(body: GenerateContentParameters, errorLabel: string): Promise<GenerateContentResponse | null> {
  let data: GenerateContentResponse;
  try {
    data = await client.models.generateContent(body);
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      // ApiError 自带 HTTP 状态码与 API 返回的错误信息，拼一行足够定位。
      logger.error(`${errorLabel} error: ${error.status} ${error.message}`);
    } else {
      logger.error(`Error calling ${errorLabel}:`, error);
    }
    return null;
  }

  if (isTruncatedByTokenLimit(data)) {
    // 被 maxOutputTokens 腰斩即便带着「已经写出半句话」的部分正文，上层照样
    // 会把这半句话当正常回复发出去，观感上就是消息突然断掉；思考型请求更
    // 容易在思考阶段就烧光额度、正文为空。不管有没有部分正文都记一条，
    // 方便观测这类「中途夭折」的频率。
    logger.error(
      `${errorLabel} response was truncated by maxOutputTokens ` +
      `(hasPartialText=${!!extractOutputText(data)}, ` +
      `thoughts_tokens=${data.usageMetadata?.thoughtsTokenCount ?? "?"}, ` +
      `max_output_tokens=${body.config?.maxOutputTokens ?? "?"}).`
    );
  }
  return data;
}
