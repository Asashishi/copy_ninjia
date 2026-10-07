import {
  EMPTY_OUTPUT_ITEMS,
  OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS,
} from "../../consts/aiChat/openai";
import { EMPTY_FUNCTION_CALLS } from "../../consts/aiChat/tools";
/**
 * OpenAI Responses 响应里的项目级诊断与 output item 解析。正文直接读 SDK 的
 * `output_text` 访问器，本文件只补 SDK 没有提供的异常收尾诊断、函数调用抽取
 * 与服务端联网检索计数。职责与 aiChat/gemini/response.ts 一一对应。
 */

import { isPlainRecord } from "../../libs/record";
import type OpenAI from "openai";
import type { AiFunctionCall } from "../../types/aiChat/provider";

/**
 * 诊断串里的一个字段：缺省返回 undefined（JSON.stringify 会把这个键整个略掉），
 * 其余一律截断成有界文本。
 *
 * 对象与数组先试序列化；序列化不出来（循环引用、BigInt、函数）时退成类型标记，
 * 本函数不抛错（见下方 describeResponseError），降级口径与 infra/logger/redaction.ts 的
 * safeStringify 兜底一致。
 */
function errorDiagnosticField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.slice(0, OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS);
  try {
    // JSON.stringify 在运行时对 function/symbol/undefined 返回 undefined，按可能缺失处理。
    const encoded: string | undefined = JSON.stringify(value);
    if (encoded !== undefined) return encoded.slice(0, OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS);
  } catch {
    // 落到下面的类型标记。
  }
  return `[unserializable ${typeof value}]`;
}

/**
 * 服务端错误对象的诊断串：`error` 可能只有 `code`、也可能是字符串，两个字段都经
 * errorDiagnosticField 限长。本函数不抛错；唯一的调用点在 requestOpenAiResult 的
 * try/catch 之外（见 openai/client.ts 里 abnormalResponseDiagnostic 的调用位置）。
 */
function describeResponseError(error: unknown): string {
  if (!isPlainRecord(error)) return JSON.stringify({ message: errorDiagnosticField(error) });
  return JSON.stringify({
    code: errorDiagnosticField(error.code),
    message: errorDiagnosticField(error.message),
  });
}

/**
 * 响应的 output item 列表。`output` 缺失（不是数组）一律按「没有 output item」处理，
 * 由 abnormalResponseDiagnostic 的诊断分支接住。
 */
export function responseOutputItems(response: OpenAI.Responses.Response): readonly OpenAI.Responses.ResponseOutputItem[] {
  const output: readonly OpenAI.Responses.ResponseOutputItem[] | undefined = response.output;
  return Array.isArray(output) ? output : EMPTY_OUTPUT_ITEMS;
}

/**
 * 响应在 HTTP 层成功、内容却不可用时的诊断串：服务端明确报错、状态不是
 * `completed`（`incomplete` 会附上 max_output_tokens / content_filter 的具体
 * 原因），或压根没有任何 output item。正常响应返回 null。
 *
 * 口径同 aiChat/gemini/response.ts 的 abnormalFinishDiagnostic。
 */
export function abnormalResponseDiagnostic(response: OpenAI.Responses.Response): string | null {
  if (response.error) {
    return `error=${describeResponseError(response.error)}`;
  }
  // status 缺失按正常处理，与下面的 normalizedFinishReason 同一口径。
  if (response.status !== undefined && response.status !== "completed") {
    const reason: string | undefined = response.incomplete_details?.reason;
    return `status=${response.status}` + (reason === undefined ? "" : `, reason=${reason}`);
  }
  if (responseOutputItems(response).length === 0) return "no output items";
  return null;
}

/**
 * 响应正文：`output_text` 不是字符串时返回空串（SDK 只在响应体带 `object: "response"` 时
 * 合成该字段）。
 */
export function responseOutputText(response: OpenAI.Responses.Response): string {
  const text: unknown = response.output_text;
  return typeof text === "string" ? text : "";
}

/** 归一化的收尾原因，供上层日志与重试判断使用；正常收尾返回 undefined。 */
export function normalizedFinishReason(response: OpenAI.Responses.Response): string | undefined {
  if (response.status === undefined || response.status === "completed") return undefined;
  const reason: string | undefined = response.incomplete_details?.reason;
  return reason === undefined ? response.status : `${response.status}:${reason}`;
}

/** 本次响应是否因为撞上 max_output_tokens 而被截断。 */
export function isTruncatedByTokenLimit(response: OpenAI.Responses.Response): boolean {
  return response.incomplete_details?.reason === "max_output_tokens";
}

/**
 * 这个 output item 是不是一次可续接的函数调用：type 为 function_call 且 `call_id` 为非空字符串。
 * `call_id` 是 function_call 与后续 function_call_output 之间的关联键；抽取
 * （extractFunctionCalls）与回灌（replySession 的 toInputItems）共用这一个判据。
 */
export function isPairableFunctionCall(item: OpenAI.Responses.ResponseOutputItem): boolean {
  return item.type === "function_call" && typeof item.call_id === "string" && item.call_id.length > 0;
}

/**
 * 抽出模型这一轮抛回的函数调用；不可续接的 item（见 isPairableFunctionCall）跳过。
 *
 * 零调用时交回共用空数组 EMPTY_FUNCTION_CALLS，不重复分配。
 */
export function extractFunctionCalls(response: OpenAI.Responses.Response): readonly AiFunctionCall[] {
  const calls: AiFunctionCall[] = [];
  for (const item of responseOutputItems(response)) {
    if (item.type !== "function_call" || !isPairableFunctionCall(item)) continue;
    calls.push({
      id: item.call_id,
      name: item.name,
      // arguments 为空串时归一成空对象。
      argumentsJson: item.arguments.length > 0 ? item.arguments : "{}",
    });
  }
  return calls.length === 0 ? EMPTY_FUNCTION_CALLS : calls;
}

/**
 * 统计一次响应中已完成的 search 动作；打开网页、页内查找和未完成的调用不计入检索次数。
 * web_search 是 hosted 工具，调用记录在 `web_search_call` item 的 action 与 status 中。
 */
export function countWebSearchCalls(response: OpenAI.Responses.Response): number {
  let calls: number = 0;
  for (const item of responseOutputItems(response)) {
    if (item.type === "web_search_call" && item.action?.type === "search" && item.status === "completed") calls++;
  }
  return calls;
}
