/**
 * OpenAI Responses 响应里的项目级诊断与 output item 解析。正文直接读 SDK 的
 * `output_text` 访问器，本文件只补 SDK 没有提供的异常收尾诊断、函数调用抽取
 * 与服务端联网检索计数。职责与 aiChat/gemini/response.ts 一一对应。
 */

import { OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS } from "../../consts/aiChat/openai";
import { isPlainRecord } from "../../libs/runtimeConfig";
import type OpenAI from "openai";
import type { AiFunctionCall } from "../../types/aiChat/provider";

/** 无 output item 时共用的空数组；理由同下方 EMPTY_FUNCTION_CALLS。 */
const EMPTY_OUTPUT_ITEMS: readonly OpenAI.Responses.ResponseOutputItem[] = [];

/**
 * 诊断串里的一个字段：缺省返回 undefined（JSON.stringify 会把这个键整个略掉），
 * 其余一律截断成有界文本。
 *
 * 对象与数组先试序列化拿到真实内容，而不是 `String()` 那样一律退成
 * `[object Object]`——兼容网关确实会往 `message` 里塞结构化的上游错误，退成占位
 * 符等于把这次诊断作废。序列化不出来（循环引用、BigInt、函数）时才退成类型标记：
 * 本函数所在的整条路径就是为「不抛」存在的（见下方 describeResponseError），
 * 降级口径与 infra/logger.ts 的 safeStringify 兜底一致。
 */
function errorDiagnosticField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.slice(0, OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS);
  try {
    // 类型上 JSON.stringify 恒回 string，运行时对 function/symbol/undefined 回
    // undefined——这里的输入完全不受本进程控制，必须按可能缺失处理。
    const encoded: string | undefined = JSON.stringify(value);
    if (encoded !== undefined) return encoded.slice(0, OPENAI_ERROR_DIAGNOSTIC_MAX_CHARS);
  } catch {
    // 落到下面的类型标记。
  }
  return `[unserializable ${typeof value}]`;
}

/**
 * 服务端错误对象的诊断串。
 *
 * SDK 把 `error` 标成 `{ code, message }` 两项必填，实际上兼容网关经常只给
 * `code`、或者干脆把 `error` 写成一个字符串。无保护的 `.message.slice()` 会在
 * 这里抛 TypeError，而本函数唯一的调用点在 requestOpenAiResult 的 try/catch
 * **之外**（见 openai/client.ts 里 abnormalResponseDiagnostic 的调用位置）：
 * 异常会一路穿过 session.request() 与 generateReply，最后被回复循环最外层的
 * .catch 吞掉——群里是整轮静默，日志里只剩一个泛化的 TypeError，恰好把这个
 * 诊断存在的意义丢干净。理由同下方 responseOutputText 对 output_text 的处理。
 *
 * 两个字段都过 errorDiagnosticField：形状不受本进程控制，长度也一样。
 */
function describeResponseError(error: unknown): string {
  if (!isPlainRecord(error)) return JSON.stringify({ message: errorDiagnosticField(error) });
  return JSON.stringify({
    code: errorDiagnosticField(error.code),
    message: errorDiagnosticField(error.message),
  });
}

/**
 * 响应的 output item 列表。
 *
 * SDK 把 `output` 标成必填数组，省略它的代理/自建网关会让它是 undefined：
 * 三个遍历点（异常诊断、函数调用抽取、检索计数）都会在 `.length` 或 for...of
 * 处抛 TypeError，冲出实现包掀掉整轮回复。缺失一律按「没有 output item」处理
 * ——那正是 abnormalResponseDiagnostic 已有的诊断分支。
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
 * 这类失败对上层与「模型没产出」不可区分，不点名记录就查无原因——口径同
 * aiChat/gemini/response.ts 的 abnormalFinishDiagnostic。
 */
export function abnormalResponseDiagnostic(response: OpenAI.Responses.Response): string | null {
  if (response.error) {
    return `error=${describeResponseError(response.error)}`;
  }
  // status 缺失按正常处理，与下面的 normalizedFinishReason 同一口径。SDK 里
  // `status?: ResponseStatus` 本就是可选的，而 OpenAI 兼容网关普遍省略它——
  // 把缺失判成异常，等于让回复、记忆压缩、贴纸包摘要、媒体描述的**每一个**
  // 请求都被丢弃，日志里还只有一句 `status=?`（因为收尾原因那边认为它正常）。
  if (response.status !== undefined && response.status !== "completed") {
    const reason: string | undefined = response.incomplete_details?.reason;
    return `status=${response.status}` + (reason === undefined ? "" : `, reason=${reason}`);
  }
  if (responseOutputItems(response).length === 0) return "no output items";
  return null;
}

/**
 * 响应正文。
 *
 * SDK 的类型把 `output_text` 标成必填 string，实际只在响应体带
 * `object: "response"` 时才合成它（node_modules/openai/resources/responses/
 * responses.mjs 的 `if ('object' in rsp && rsp.object === 'response')`）；省略
 * 该字段的代理/自建网关会让它是 undefined。无保护解引用会在
 * `output_text.length` 处抛 TypeError 冲出实现包、掀掉整轮回复，或者被
 * 字符串化成字面量 `"undefined"` 混进摘要与媒体描述。
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

/** 本次响应是否因为撞上 max_output_tokens 而被腰斩。 */
export function isTruncatedByTokenLimit(response: OpenAI.Responses.Response): boolean {
  return response.incomplete_details?.reason === "max_output_tokens";
}

/** 无函数调用时共用的空数组：调用方只读，不必每轮新建一个空数组。 */
export const EMPTY_FUNCTION_CALLS: readonly AiFunctionCall[] = [];

/**
 * 这个 output item 是不是一次**可续接**的函数调用。
 *
 * `call_id` 是 function_call 与后续 function_call_output 之间唯一的关联键，
 * 缺了就配不上对。抽取（extractFunctionCalls）与回灌（replySession 的
 * toInputItems）必须共用同一个判据：只在一边过滤，就会出现「被丢弃的那条
 * 却被推回 input、且没有对应输出」，下一轮请求被服务端以
 * `No tool output found for function call ...` 整体 400 拒绝——而此时第一个
 * 工具的副作用已经落地，用户看到的是一条被截断的单动作回复。
 */
export function isPairableFunctionCall(item: OpenAI.Responses.ResponseOutputItem): boolean {
  return item.type === "function_call" && typeof item.call_id === "string" && item.call_id.length > 0;
}

/**
 * 抽出模型这一轮抛回的函数调用。`call_id` 是回填 function_call_output 的必填
 * 关联键，缺了这一条的 item 无法续接，直接跳过。
 *
 * 零调用时交回上面那个共用空数组：每个回复的最后一轮按构造必然是零 function
 * call 的 turn（那正是 workers/aiChat/replyModel.ts 的循环退出条件），再加上
 * 每个纯文本中间轮——哨兵原本只接在 `!result.ok` 的冷分支上，真正有流量的
 * 成功路径反而每轮都新分配一个空数组。
 */
export function extractFunctionCalls(response: OpenAI.Responses.Response): readonly AiFunctionCall[] {
  const calls: AiFunctionCall[] = [];
  for (const item of responseOutputItems(response)) {
    if (item.type !== "function_call" || !isPairableFunctionCall(item)) continue;
    calls.push({
      id: item.call_id,
      name: item.name,
      // Responses API 的 arguments 本就是 JSON 字符串；模型偶尔给空串，
      // 归一成空对象，让领域侧的解析路径只处理一种形状。
      argumentsJson: item.arguments.length > 0 ? item.arguments : "{}",
    });
  }
  return calls.length === 0 ? EMPTY_FUNCTION_CALLS : calls;
}

/**
 * 统计一次响应中服务端已执行的联网检索调用。web_search 是 hosted 工具，
 * 检索在 OpenAI 侧自动执行、结果直接体现在最终正文里，只以
 * `web_search_call` item 的形式留下调用记录。
 */
export function countWebSearchCalls(response: OpenAI.Responses.Response): number {
  let calls: number = 0;
  for (const item of responseOutputItems(response)) {
    if (item.type === "web_search_call") calls++;
  }
  return calls;
}
