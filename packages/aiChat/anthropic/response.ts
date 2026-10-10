import type Anthropic from "@anthropic-ai/sdk";
import { finishDetailsJson } from "../ai/utils/finishDetails";
import type { AiFunctionCall, AiWebSearchSource } from "../../types/aiChat/provider";

/**
 * Anthropic Messages（beta 端点）响应的读取辅助：正文、自定义函数调用、服务端检索计数、检索来源，
 * 收尾详情，以及 betaRefusalFallbackMiddleware 改道的诊断。aiChat 实现包与 ad_detect 传输层共用。
 */

/** 全部 text 块的拼接；一个都没有时为空串。 */
export function messageText(message: Anthropic.Beta.BetaMessage): string {
  let text: string = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/** 模型要求执行的自定义函数调用；入参对象序列化成 JSON 字符串交给领域侧解析。 */
export function toolUseCalls(message: Anthropic.Beta.BetaMessage): readonly AiFunctionCall[] {
  const calls: AiFunctionCall[] = [];
  for (const block of message.content) {
    if (block.type === "tool_use") calls.push({ id: block.id, name: block.name, argumentsJson: JSON.stringify(block.input) });
  }
  return calls;
}

/**
 * 服务端已执行的联网检索次数：以 `usage.server_tool_use.web_search_requests` 为准，缺失时按
 * 成功的 `web_search_tool_result` 块数兜底；未执行的调用与错误结果不计数。
 */
export function countAnthropicWebSearches(message: Anthropic.Beta.BetaMessage): number {
  const reported: number | undefined = message.usage?.server_tool_use?.web_search_requests;
  if (typeof reported === "number") return reported;
  let calls: number = 0;
  for (const block of message.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) calls++;
  }
  return calls;
}

/** HTTP 成功响应中的检索工具错误码；没有错误时为 undefined。 */
export function anthropicSearchError(message: Anthropic.Beta.BetaMessage): string | undefined {
  for (const block of message.content) {
    if (block.type === "web_search_tool_result" && !Array.isArray(block.content)) return block.content.error_code;
  }
  return undefined;
}

/**
 * 检索来源：先取正文引用（`web_search_result_location`）的地址，再补上检索结果块里出现过的地址，
 * 按出现顺序，未去重。
 */
export function anthropicSearchSources(message: Anthropic.Beta.BetaMessage): readonly AiWebSearchSource[] {
  const sources: AiWebSearchSource[] = [];
  for (const block of message.content) {
    if (block.type !== "text") continue;
    for (const citation of block.citations ?? []) {
      if (citation.type === "web_search_result_location") sources.push({ title: citation.title ?? citation.url, url: citation.url });
    }
  }
  for (const block of message.content) {
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const result of block.content) sources.push({ title: result.title, url: result.url });
  }
  return sources;
}

/**
 * 回退模型接手时的诊断串：`from=<拒答模型>, to=<回退模型>, trigger=<trigger JSON>, fallback_credit=<usage.fallback_credit
 * JSON 或 null>`，取自 betaRefusalFallbackMiddleware 在 content 前置的 `fallback` 块（回退链只有 fallback_model
 * 一项，至多一块）；没有改道时为 undefined。
 */
export function anthropicFallbackSummary(message: Anthropic.Beta.BetaMessage): string | undefined {
  for (const block of message.content) {
    if (block.type !== "fallback") continue;
    return `from=${block.from.model}, to=${block.to.model}, trigger=${finishDetailsJson(block.trigger) ?? "null"}, ` +
      `fallback_credit=${finishDetailsJson(message.usage?.fallback_credit) ?? "null"}`;
  }
  return undefined;
}

/**
 * `stop_details` 的诊断串：去掉 `fallback_credit_token`（拒答带回的、可兑换的回退额度令牌）后按 finishDetailsJson
 * 序列化，其余字段原样保留；字段为 null 或缺失时为 undefined。
 */
export function anthropicStopDetailsJson(message: Anthropic.Beta.BetaMessage): string | undefined {
  const details: Anthropic.Beta.BetaRefusalStopDetails | null | undefined = message.stop_details;
  if (details === null || details === undefined) return undefined;
  return finishDetailsJson("fallback_credit_token" in details ? { ...details, fallback_credit_token: undefined } : details);
}
