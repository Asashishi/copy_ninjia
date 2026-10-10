/**
 * 供应商收尾详情的诊断串，各家实现包共用：Anthropic 的 `stop_details`、Gemini 的
 * `finishMessage`/`safetyRatings`/`promptFeedback`、OpenAI 的 `error` 与拒答说明（Responses 的
 * `refusal` 内容块、Chat Completions 的 `message.refusal`），
 * 由各调用方取出后经这里序列化，供 aiChat 各实现包与 ad_detect 传输层的「不可用响应」日志，
 * 以及回复轮次的 finishDetails 使用。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import { AI_FINISH_DETAILS_MAX_CHARS } from "../../../consts/aiChat/provider";

/**
 * 把详情对象序列化成有界 JSON 串：null/undefined 返回 undefined，其余按
 * AI_FINISH_DETAILS_MAX_CHARS 截断。对象里值为 undefined 的键被 JSON.stringify 略去。
 *
 * 序列化不出来（循环引用、BigInt、函数）时退成 `[unserializable <typeof>]` 标记，本函数不抛错。
 */
export function finishDetailsJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    // JSON.stringify 在运行时对 function/symbol 返回 undefined，按可能缺失处理。
    const encoded: string | undefined = JSON.stringify(value);
    if (encoded !== undefined) return encoded.slice(0, AI_FINISH_DETAILS_MAX_CHARS);
  } catch {
    // 落到下面的类型标记。
  }
  return `[unserializable ${typeof value}]`;
}

/** 「unusable response」类诊断串的统一写法：收尾原因在前，有详情时接 `, details=<详情>`。 */
export function diagnosticWithDetails(diagnostic: string, finishDetails: string | undefined): string {
  return finishDetails === undefined ? diagnostic : `${diagnostic}, details=${finishDetails}`;
}
