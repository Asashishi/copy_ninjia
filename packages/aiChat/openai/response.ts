import { EMPTY_OUTPUT_ITEMS } from "../../consts/aiChat/openai";
import { EMPTY_FUNCTION_CALLS } from "../../consts/aiChat/tools";
/**
 * OpenAI Responses 响应里的项目级诊断与 output item 解析。正文直接读 SDK 的
 * `output_text` 访问器，本文件只补 SDK 没有提供的异常收尾诊断与详情、函数调用抽取
 * 与服务端联网检索计数。职责与 aiChat/gemini/response.ts 一一对应。
 */

import { finishDetailsJson } from "../ai/utils/finishDetails";
import type OpenAI from "openai";
import type { AiFunctionCall } from "../../types/aiChat/provider";

/**
 * 响应的 output item 列表。`output` 缺失（不是数组）一律按「没有 output item」处理，
 * 由 abnormalResponseDiagnostic 的诊断分支接住。
 */
export function responseOutputItems(response: OpenAI.Responses.Response): readonly OpenAI.Responses.ResponseOutputItem[] {
  const output: readonly OpenAI.Responses.ResponseOutputItem[] | undefined = response.output;
  return Array.isArray(output) ? output : EMPTY_OUTPUT_ITEMS;
}

/**
 * 模型拒答的说明：message item 里全部 `refusal` 内容块的文本，按出现顺序拼接；一个 `refusal`
 * 块都没有时返回 undefined（与「有拒答块但文本为空」区分开）。兼容网关缺 content 数组或
 * 文本不是字符串时跳过该处。
 */
export function responseRefusal(response: OpenAI.Responses.Response): string | undefined {
  let refusal: string | undefined;
  for (const item of responseOutputItems(response)) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type !== "refusal") continue;
      refusal = (refusal ?? "") + (typeof part.refusal === "string" ? part.refusal : "");
    }
  }
  return refusal;
}

/**
 * 响应在 HTTP 层成功、内容却不可用时的诊断串：服务端明确报错、状态不是
 * `completed`（`incomplete` 会附上 max_output_tokens / content_filter 的具体
 * 原因）、模型以 `refusal` 内容块拒答，或压根没有任何 output item。正常响应返回 null。
 * 错误对象与拒答说明见 openAiFinishDetails。
 *
 * 口径同 aiChat/gemini/response.ts 的 abnormalFinishDiagnostic。
 */
export function abnormalResponseDiagnostic(response: OpenAI.Responses.Response): string | null {
  if (response.error) return "error";
  // status 缺失按正常处理，与下面的 normalizedFinishReason 同一口径。
  if (response.status !== undefined && response.status !== "completed") {
    const reason: string | undefined = response.incomplete_details?.reason;
    return `status=${response.status}` + (reason === undefined ? "" : `, reason=${reason}`);
  }
  if (responseRefusal(response) !== undefined) return "refusal";
  if (responseOutputItems(response).length === 0) return "no output items";
  return null;
}

/**
 * 收尾详情的诊断串（见 aiChat/ai/utils/finishDetails.ts）：`{ error, refusal }`，error 是服务端
 * 错误对象原样（兼容网关可能只给 code、或整个是字符串），refusal 见 responseRefusal。两者都没有时
 * 返回 undefined。
 */
export function openAiFinishDetails(response: OpenAI.Responses.Response): string | undefined {
  const error: unknown = response.error ?? undefined;
  const refusal: string | undefined = responseRefusal(response);
  if (error === undefined && refusal === undefined) return undefined;
  return finishDetailsJson({ error, refusal });
}

/**
 * 响应正文：`output_text` 不是字符串时返回空串（SDK 只在响应体带 `object: "response"` 时
 * 合成该字段）。
 */
export function responseOutputText(response: OpenAI.Responses.Response): string {
  const text: unknown = response.output_text;
  return typeof text === "string" ? text : "";
}

/**
 * 归一化的收尾原因，供上层日志与重试判断使用：状态不是 `completed` 时为 `status` 或
 * `status:reason`，正常收尾但带 `refusal` 内容块时为 `refusal`，其余返回 undefined。
 */
export function normalizedFinishReason(response: OpenAI.Responses.Response): string | undefined {
  if (response.status === undefined || response.status === "completed") {
    return responseRefusal(response) === undefined ? undefined : "refusal";
  }
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
