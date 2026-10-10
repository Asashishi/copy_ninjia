/**
 * Anthropic 侧的联网检索执行器（web_search 或 text 能力）：用该能力的模型发一次挂内建
 * 检索工具（ANTHROPIC_WEB_SEARCH_TOOL_TYPE，`allowed_callers: ["direct"]`）的单轮请求，交回结论正文、引用与检索结果
 * 给出的来源与实际检索次数。服务端工具循环暂停（`pause_turn`）时把已得内容作为续写前缀再发，
 * 最多 ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS 次，续发与首次请求共用一份 BetaFallbackState。收发与失败
 * 归一化走 client.ts 的 requestAnthropicMessage；token 与检索次数在那里按同一响应上报。HTTP 成功中的
 * 工具错误按失败交回，拒答按带 `refused` 的失败交回。
 */

import type Anthropic from "@anthropic-ai/sdk";
import { BetaFallbackState } from "@anthropic-ai/sdk";
import {
  ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS,
  ANTHROPIC_WEB_SEARCH_ERROR_LABEL,
  ANTHROPIC_WEB_SEARCH_MAX_TOKENS,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
} from "../../consts/aiChat/anthropic";
import { requireAgentCapabilityConfig } from "../../config/agent";
import { requestAnthropicMessage } from "./client";
import { anthropicSearchError, anthropicSearchSources, countAnthropicWebSearches, messageText } from "./response";
import { logger } from "../../infra/logger";
import type { AnthropicRequestResult } from "../../types/aiChat/anthropic";
import type {
  AiWebSearchCapability,
  AiWebSearchRequest,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../types/aiChat/provider";

/** 按指定能力执行一次联网检索；请求失败与工具错误分别在客户端和此边界记日志。 */
export async function searchAnthropicWeb(
  capability: AiWebSearchCapability,
  request: AiWebSearchRequest
): Promise<AiWebSearchResult> {
  let searchCalls: number = 0;
  let text: string = "";
  const sources: AiWebSearchSource[] = [];
  const fallbackState: BetaFallbackState = new BetaFallbackState();
  let paused: Anthropic.Beta.BetaContentBlockParam[] | null = null;
  for (let continuation: number = 0; ; continuation++) {
    const prefix: Anthropic.Beta.BetaContentBlockParam[] | null = paused;
    const result: AnthropicRequestResult = await requestAnthropicMessage({
      capability,
      buildBody: (): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming => {
        // web_search 没配时抛错，由 requestAnthropicMessage 的 try 归一成失败；text 取对话模型。
        const model: string = requireAgentCapabilityConfig(capability).model;
        const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: request.query }];
        if (prefix !== null) messages.push({ role: "assistant", content: prefix });
        return {
          model,
          system: request.instruction,
          messages,
          tools: [{ type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: ANTHROPIC_WEB_SEARCH_TOOL_NAME, allowed_callers: ["direct"] }],
          max_tokens: ANTHROPIC_WEB_SEARCH_MAX_TOKENS,
        };
      },
      errorLabel: ANTHROPIC_WEB_SEARCH_ERROR_LABEL,
      signal: request.signal,
      fallbackState,
    });
    const searches: number = result.message === undefined ? 0 : countAnthropicWebSearches(result.message);
    searchCalls += searches;

    if (!result.ok) return result.failureKind === "refused" ? { ok: false, searchCalls, refused: true } : { ok: false, searchCalls };
    const searchError: string | undefined = anthropicSearchError(result.message);
    if (searchError !== undefined) {
      logger.error(`${ANTHROPIC_WEB_SEARCH_ERROR_LABEL} tool failed: ${searchError}.`);
      return { ok: false, searchCalls };
    }
    text += messageText(result.message);
    sources.push(...anthropicSearchSources(result.message));
    if (result.message.stop_reason !== "pause_turn") return { ok: true, text, sources, searchCalls };
    if (continuation >= ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS) return { ok: false, searchCalls };
    paused = prefix === null ? result.message.content : [...prefix, ...result.message.content];
  }
}
