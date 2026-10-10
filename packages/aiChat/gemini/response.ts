import { FinishReason, ToolType } from "@google/genai";
import type { Candidate, GenerateContentResponse, Part } from "@google/genai";
import { finishDetailsJson } from "../ai/utils/finishDetails";

/**
 * Gemini generateContent 响应的读取辅助：自定义函数调用直接使用 SDK 的
 * response.functionCalls，本文件保留正文读取、异常收尾诊断与详情、服务端 Google Search
 * 预算统计。全部只看第一个 candidate。
 *
 * 纯函数模块，不接触任何缓存：Anti-Raid Worker 的 ad_detect 传输层
 * （workers/antiRaid/adDetect/ai/google.ts）复用其中的异常收尾诊断与详情。
 */

function firstCandidate(data: GenerateContentResponse): Candidate | undefined {
  return data.candidates?.[0];
}

function responseParts(data: GenerateContentResponse): readonly Part[] {
  return firstCandidate(data)?.content?.parts ?? [];
}

/**
 * 第一个 candidate 的正文：所有非 thought 文本 part 的拼接；一个文本 part 都没有时
 * 返回 undefined（与「有文本 part 但内容是空串」区分开）。取值语义与 SDK 的
 * `GenerateContentResponse.text` 逐项一致；本函数自行遍历 parts，不调用该 getter，不产生
 * console 输出。
 */
export function responseText(data: GenerateContentResponse): string | undefined {
  let text: string = "";
  let hasTextPart: boolean = false;
  for (const part of responseParts(data)) {
    if (typeof part.text !== "string" || part.thought === true) continue;
    hasTextPart = true;
    text += part.text;
  }
  return hasTextPart ? text : undefined;
}

/** 响应在 HTTP 层成功、内容却不可用时的诊断串：candidates 缺失，或 finishReason
 *  不是正常收尾的 STOP（MAX_TOKENS 会由 requestGeminiResult 额外记录 token
 *  诊断，但契约上同样不可用）。正常响应返回 null。具体详情见 geminiFinishDetails。 */
export function abnormalFinishDiagnostic(data: GenerateContentResponse): string | null {
  const candidate: Candidate | undefined = firstCandidate(data);
  if (!candidate) return "no candidates";
  const finishReason: FinishReason | undefined = candidate.finishReason;
  if (finishReason === undefined) return "missing finishReason";
  if (finishReason !== FinishReason.STOP) return `finishReason=${finishReason}`;
  return null;
}

/**
 * 收尾详情的诊断串（见 aiChat/ai/utils/finishDetails.ts）。有 candidate 时是它的
 * `{ finishMessage, safetyRatings }`；没有 candidate 时是 `{ promptFeedback }`——提示词被拦截时
 * blockReason 与 safetyRatings 就在里面。对应字段都缺省时返回 undefined。
 */
export function geminiFinishDetails(data: GenerateContentResponse): string | undefined {
  const candidate: Candidate | undefined = firstCandidate(data);
  if (!candidate) {
    return data.promptFeedback === undefined ? undefined : finishDetailsJson({ promptFeedback: data.promptFeedback });
  }
  if (candidate.finishMessage === undefined && candidate.safetyRatings === undefined) return undefined;
  return finishDetailsJson({ finishMessage: candidate.finishMessage, safetyRatings: candidate.safetyRatings });
}

/**
 * 统计一次响应中已经由服务端执行的 Google Search 调用。开启
 * includeServerSideToolInvocations 时以 toolCall 为准；没有这些
 * part 时，用 groundingMetadata.webSearchQueries 的查询数兜底。
 */
export function countGoogleSearchCalls(data: GenerateContentResponse): number {
  let explicitCalls: number = 0;
  for (const part of responseParts(data)) {
    if (part.toolCall?.toolType === ToolType.GOOGLE_SEARCH_WEB) explicitCalls++;
  }
  if (explicitCalls > 0) return explicitCalls;

  return firstCandidate(data)?.groundingMetadata?.webSearchQueries?.length ?? 0;
}
