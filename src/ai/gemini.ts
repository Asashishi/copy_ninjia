/**
 * Gemini generateContent 的底层收发与响应解析。回复流水线（workers/aiChatWorker.ts
 * 的工具往返循环）、冷消息压缩（summarizeBatch）、图片描述
 * （ai/imageDescription.ts）共用。
 *
 * 收发走官方 @google/genai SDK（Google 现行的统一 GenAI JS SDK）而不是手写
 * fetch：SDK 自带每次请求的超时（httpOptions.timeout）与瞬时失败（网络错误/
 * 5xx/429）的自动重试（默认最多 5 次尝试），比自己维护一份 AbortController
 * 省心。已用真实请求逐项验证过：内置 googleSearch（服务端工具）与自定义
 * 函数声明（客户端工具）能混用同一次请求（需开 toolConfig.
 * includeServerSideToolInvocations，见 callGemini）、视觉输入（inlineData）
 * 能用、多轮函数调用往返也正常（把上一轮模型的整个 content——含 thought
 * signature——原样接回 contents 再附上 functionResponse，见
 * workers/aiChatWorker.ts 的 callGemini）。
 *
 * generateContent 的响应形状：candidates[0].content.parts 数组，成员按字段
 * 区分——text（正文；带 thought: true 的是思考摘要，不算正文）、
 * functionCall（自定义函数调用请求，带 id/name/args）等；candidates[0]
 * .finishReason 标记结束原因（"STOP" 正常收尾、"MAX_TOKENS" 被输出上限
 * 腰斩等）。googleSearch 是服务端工具，搜索在 Google 侧自动执行，结果直接
 * 体现在最终文本里，不会以 functionCall 形式抛回来。
 */

import { ApiError, GoogleGenAI } from "@google/genai";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { logger } from "../infra/logger";
import { GEMINI_API_KEY } from "../infra/config";
import { REQUEST_TIMEOUT_MS } from "../consts/aiChat";

/** 进程内唯一的 Gemini 客户端实例（timeout 是每次请求/每次重试各自的预算，
 *  不是所有重试共享一个硬顶，见 consts/aiChat.ts 的 REQUEST_TIMEOUT_MS 注释）。
 *  Worker 线程各自 import 本文件会各自拿到一份独立实例，符合现状——本来
 *  就没有跨线程共享 Gemini 调用状态的需求。 */
const client: GoogleGenAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });

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

/**
 * 响应是否因为撞上 maxOutputTokens 而被腰斩——这类响应即便带着部分正文，
 * 也是写到一半戛然而止，不该当成正常回复发出去（区别于其它非 STOP 的
 * finishReason，比如安全拦截，那种没有「差一点写完」的错觉，上层按空文本
 * 处理即可）。调用方据此决定：与其把半句话发到群里，不如这轮直接放弃。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstCandidate(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data) || !Array.isArray(data.candidates)) return undefined;
  const candidate: unknown = data.candidates[0];
  return isRecord(candidate) ? candidate : undefined;
}

function responseParts(data: unknown): unknown[] {
  const content: unknown = firstCandidate(data)?.content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return [];
  return content.parts;
}

export function isTruncatedByTokenLimit(data: unknown): boolean {
  return firstCandidate(data)?.finishReason === "MAX_TOKENS";
}

/** 拼出响应里的最终文本：首个候选 content.parts 中所有非思考的 text 段按序
 *  连接；没有则为空串。SDK 的响应对象本身带一个 text 便捷属性，效果一样，
 *  这里仍手写遍历——纯函数，不依赖 SDK 响应类的具体实现，测试用的手搭
 *  fixture 也能直接跑。 */
export function extractOutputText(data: unknown): string {
  const parts: string[] = [];
  for (const part of responseParts(data)) {
    if (!isRecord(part) || part.thought === true) continue;
    if (typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

/** 取出响应里所有待执行的自定义函数调用（内置服务端工具如 googleSearch
 *  不在此列，它们已在 Google 侧执行完）。返回的是 parts 里的 functionCall
 *  对象本身（id/name/args）。 */
export interface ExtractedFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export function extractFunctionCalls(data: unknown): ExtractedFunctionCall[] {
  const calls: ExtractedFunctionCall[] = [];
  for (const part of responseParts(data)) {
    if (!isRecord(part) || !isRecord(part.functionCall)) continue;
    const call: Record<string, unknown> = part.functionCall;
    if (typeof call.name !== "string") continue;
    calls.push({
      id: typeof call.id === "string" ? call.id : undefined,
      name: call.name,
      args: isRecord(call.args) ? call.args : {},
    });
  }
  return calls;
}
