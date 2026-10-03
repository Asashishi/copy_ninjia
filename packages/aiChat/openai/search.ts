/**
 * OpenAI 侧的联网检索执行器（web_search 或 text 能力）：用该能力的模型发一次挂 hosted `web_search`
 * 的 Responses 单轮请求，交回结论正文、`url_citation` 引用的来源与实际检索次数。收发与失败
 * 归一化走 client.ts 的 requestOpenAiResult；token 与检索次数在那里按同一响应上报。
 */

import type OpenAI from "openai";
import {
  OPENAI_STORE_RESPONSES,
  OPENAI_WEB_SEARCH_ERROR_LABEL,
  OPENAI_WEB_SEARCH_MAX_TOKENS,
} from "../../consts/aiChat/openai";
import { requireAgentCapabilityConfig } from "../../config/agent";
import { requestOpenAiResult } from "./client";
import { countWebSearchCalls, responseOutputItems, responseOutputText } from "./response";
import type { OpenAiRequestResult } from "../../types/aiChat/openai";
import type {
  AiWebSearchCapability,
  AiWebSearchRequest,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../types/aiChat/provider";

/** 正文里 `url_citation` 注释给出的来源，按出现顺序。 */
function citedSources(response: OpenAI.Responses.Response): readonly AiWebSearchSource[] {
  const sources: AiWebSearchSource[] = [];
  for (const item of responseOutputItems(response)) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      for (const annotation of content.annotations) {
        if (annotation.type === "url_citation") sources.push({ title: annotation.title, url: annotation.url });
      }
    }
  }
  return sources;
}

/** 按指定能力执行一次联网检索；不抛出，失败已由 requestOpenAiResult 记日志。 */
export async function searchOpenAiWeb(
  capability: AiWebSearchCapability,
  request: AiWebSearchRequest
): Promise<AiWebSearchResult> {
  const result: OpenAiRequestResult = await requestOpenAiResult({
    capability,
    buildBody: (): OpenAI.Responses.ResponseCreateParamsNonStreaming => {
      // web_search 没配时抛错，由 requestOpenAiResult 的 try 归一成失败；text 取对话模型。
      const model: string = requireAgentCapabilityConfig(capability).model;
      return {
        model,
        instructions: request.instruction,
        input: request.query,
        tools: [{ type: "web_search" }],
        max_output_tokens: OPENAI_WEB_SEARCH_MAX_TOKENS,
        store: OPENAI_STORE_RESPONSES,
      };
    },
    errorLabel: OPENAI_WEB_SEARCH_ERROR_LABEL,
    signal: request.signal,
  });
  const response: OpenAI.Responses.Response | undefined = result.response;
  const searchCalls: number = response === undefined ? 0 : countWebSearchCalls(response);

  if (!result.ok) return { ok: false, searchCalls };
  return { ok: true, text: responseOutputText(result.response), sources: citedSources(result.response), searchCalls };
}
