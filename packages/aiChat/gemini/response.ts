import { FinishReason, ToolType } from "@google/genai";
import type { Candidate, GenerateContentResponse, Part } from "@google/genai";

/**
 * Gemini generateContent 响应的读取辅助：自定义函数调用直接使用 SDK 的
 * response.functionCalls，本文件保留正文读取、异常收尾诊断与服务端 Google Search
 * 预算统计。三者都只看第一个 candidate（请求不设 candidateCount，恒为 1）。
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
 * `GenerateContentResponse.text` 逐项一致。
 *
 * 不直接用那个 getter，是因为它带一个绕不开的副作用：响应里只要出现任何非文本
 * part，它就 `console.warn` 一行「there are non-text parts ... in the response」。而带
 * functionCall 的响应正是工具轮的常态，于是每一个工具轮都往 stderr 刷一行——那行
 * 既不经 infra/logger.ts，也不指向任何需要处理的异常。这里只去掉那个副作用，取值
 * 一个字都不改。
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

/** 响应在 HTTP 层成功、内容却不可用时的诊断串：candidates 缺失（附上
 *  promptFeedback——提示词层被拦截时 blockReason 就在里面），或 finishReason
 *  不是正常收尾的 STOP（MAX_TOKENS 会由 requestGeminiResult 额外记录 token
 *  诊断，但契约上同样不可用）。正常响应返回
 *  null。这类失败对上层与「模型没产出」不可区分，不点名记录就查无原因。 */
export function abnormalFinishDiagnostic(data: GenerateContentResponse): string | null {
  const candidate: Candidate | undefined = firstCandidate(data);
  if (!candidate) {
    return `no candidates (promptFeedback=${JSON.stringify(data.promptFeedback ?? null)})`;
  }
  const finishReason: FinishReason | undefined = candidate.finishReason;
  if (finishReason === undefined) return "missing finishReason";
  if (finishReason !== FinishReason.STOP) {
    const finishMessage: string | undefined = candidate.finishMessage;
    return `finishReason=${finishReason}` +
      (finishMessage === undefined ? "" : `, finishMessage=${JSON.stringify(finishMessage.slice(0, 500))}`);
  }
  return null;
}

/**
 * 统计一次响应中已经由服务端执行的 Google Search 调用。开启
 * includeServerSideToolInvocations 时以 toolCall 为准；旧/降级响应没有这些
 * part 时，用 groundingMetadata.webSearchQueries 的查询数做保守兜底。
 */
export function countGoogleSearchCalls(data: GenerateContentResponse): number {
  let explicitCalls: number = 0;
  for (const part of responseParts(data)) {
    if (part.toolCall?.toolType === ToolType.GOOGLE_SEARCH_WEB) explicitCalls++;
  }
  if (explicitCalls > 0) return explicitCalls;

  return firstCandidate(data)?.groundingMetadata?.webSearchQueries?.length ?? 0;
}
