import type Anthropic from "@anthropic-ai/sdk";
import type { AiFunctionCall, AiWebSearchSource } from "../../types/aiChat/provider";

/**
 * Anthropic Messages 响应的读取辅助：正文、自定义函数调用、服务端检索计数与检索来源。
 */

/** 全部 text 块的拼接；一个都没有时为空串。 */
export function messageText(message: Anthropic.Message): string {
  let text: string = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/** 模型要求执行的自定义函数调用；入参对象序列化成 JSON 字符串交给领域侧解析。 */
export function toolUseCalls(message: Anthropic.Message): readonly AiFunctionCall[] {
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
export function countAnthropicWebSearches(message: Anthropic.Message): number {
  const reported: number | undefined = message.usage?.server_tool_use?.web_search_requests;
  if (typeof reported === "number") return reported;
  let calls: number = 0;
  for (const block of message.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) calls++;
  }
  return calls;
}

/** HTTP 成功响应中的检索工具错误码；没有错误时为 undefined。 */
export function anthropicSearchError(message: Anthropic.Message): string | undefined {
  for (const block of message.content) {
    if (block.type === "web_search_tool_result" && !Array.isArray(block.content)) return block.content.error_code;
  }
  return undefined;
}

/**
 * 检索来源：先取正文引用（`web_search_result_location`）的地址，再补上检索结果块里出现过的地址，
 * 按出现顺序，未去重。
 */
export function anthropicSearchSources(message: Anthropic.Message): readonly AiWebSearchSource[] {
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
