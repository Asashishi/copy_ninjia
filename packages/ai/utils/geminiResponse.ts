import type { ExtractedFunctionCall } from "../../types/tools";

/**
 * Gemini generateContent 响应形状的纯解析层：不做任何网络请求，只负责从
 * 响应对象里结构性地取出文本/函数调用/截断标记（见 ai/gemini.ts 的
 * requestGeminiResponse）。candidates[0].content.parts 数组，成员按字段
 * 区分——text（正文；带 thought: true 的是思考摘要，不算正文）、
 * functionCall（自定义函数调用请求，带 id/name/args）等；candidates[0]
 * .finishReason 标记结束原因（"STOP" 正常收尾、"MAX_TOKENS" 被输出上限
 * 腰斩等）。手写遍历而非依赖 SDK 响应类的 text 便捷属性——纯函数不依赖
 * SDK 响应类的具体实现，测试用的手搭 fixture 也能直接跑。
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

/**
 * 响应是否因为撞上 maxOutputTokens 而被腰斩——这类响应即便带着部分正文，
 * 也是写到一半戛然而止，不该当成正常回复发出去（区别于其它非 STOP 的
 * finishReason，比如安全拦截，那种没有「差一点写完」的错觉，上层按空文本
 * 处理即可）。调用方据此决定：与其把半句话发到群里，不如这轮直接放弃。
 */
export function isTruncatedByTokenLimit(data: unknown): boolean {
  return firstCandidate(data)?.finishReason === "MAX_TOKENS";
}

/** 返回首个 candidate 的 finishReason；SDK 尚未认识的新枚举值也按字符串保留。 */
export function extractFinishReason(data: unknown): string | undefined {
  const finishReason: unknown = firstCandidate(data)?.finishReason;
  return typeof finishReason === "string" ? finishReason : undefined;
}

/** 服务端随异常 finish reason 返回的简短诊断；未知 SDK 字段也按字符串读取。 */
export function extractFinishMessage(data: unknown): string | undefined {
  const finishMessage: unknown = firstCandidate(data)?.finishMessage;
  return typeof finishMessage === "string" ? finishMessage : undefined;
}

/** 拼出响应里的最终文本：首个候选 content.parts 中所有非思考的 text 段按序连接；没有则为空串。 */
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

/** 响应在 HTTP 层成功、内容却不可用时的诊断串：candidates 缺失（附上
 *  promptFeedback——提示词层被拦截时 blockReason 就在里面），或 finishReason
 *  不是正常收尾的 STOP（MAX_TOKENS 会由 requestGeminiResult 额外记录 token
 *  诊断，但契约上同样不可用）。正常响应返回
 *  null。这类失败对上层与「模型没产出」不可区分，不点名记录就查无原因。 */
export function abnormalFinishDiagnostic(data: unknown): string | null {
  const candidate: Record<string, unknown> | undefined = firstCandidate(data);
  if (!candidate) {
    const feedback: unknown = isRecord(data) ? data.promptFeedback : undefined;
    return `no candidates (promptFeedback=${JSON.stringify(feedback ?? null)})`;
  }
  const finishReason: unknown = candidate.finishReason;
  if (typeof finishReason !== "string") return "missing finishReason";
  if (finishReason !== "STOP") {
    const finishMessage: unknown = candidate.finishMessage;
    return `finishReason=${finishReason}` +
      (typeof finishMessage === "string" ? `, finishMessage=${JSON.stringify(finishMessage.slice(0, 500))}` : "");
  }
  return null;
}

/** 取出响应里所有待执行的自定义函数调用（内置服务端工具如 googleSearch
 *  不在此列，它们已在 Google 侧执行完）。返回的是 parts 里的 functionCall
 *  对象本身（id/name/args）。 */
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

/**
 * 统计一次响应中已经由服务端执行的 Google Search 调用。开启
 * includeServerSideToolInvocations 时以 toolCall 为准；旧/降级响应没有这些
 * part 时，用 groundingMetadata.webSearchQueries 的查询数做保守兜底。
 */
export function countGoogleSearchCalls(data: unknown): number {
  let explicitCalls: number = 0;
  for (const part of responseParts(data)) {
    if (!isRecord(part) || !isRecord(part.toolCall)) continue;
    if (part.toolCall.toolType === "GOOGLE_SEARCH_WEB") explicitCalls++;
  }
  if (explicitCalls > 0) return explicitCalls;

  const groundingMetadata: unknown = firstCandidate(data)?.groundingMetadata;
  if (!isRecord(groundingMetadata) || !Array.isArray(groundingMetadata.webSearchQueries)) return 0;
  return groundingMetadata.webSearchQueries.length;
}
