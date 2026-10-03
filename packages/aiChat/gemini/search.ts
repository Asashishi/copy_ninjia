/**
 * Gemini 侧的联网检索执行器（web_search 或 text 能力）：用该能力的模型发一次挂 `googleSearch` 的
 * generateContent 单轮请求，交回结论正文、groundingChunks 给出的来源与实际检索次数。收发与
 * 失败归一化走 client.ts 的 requestGeminiResult；token 与检索次数在那里按同一响应上报。
 */

import {
  GEMINI_WEB_SEARCH_ERROR_LABEL,
  GEMINI_WEB_SEARCH_MAX_TOKENS,
} from "../../consts/aiChat/gemini";
import { requireAgentCapabilityConfig } from "../../config/agent";
import { requestGeminiResult } from "./client";
import { countGoogleSearchCalls, responseText } from "./response";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import type { GeminiRequestResult } from "../../types/aiChat/gemini";
import type {
  AiWebSearchCapability,
  AiWebSearchRequest,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../types/aiChat/provider";

/** 第一个 candidate 的 groundingChunks 里带地址的网页来源，按出现顺序；没有标题时以地址代替。 */
function groundedSources(data: GenerateContentResponse): readonly AiWebSearchSource[] {
  const sources: AiWebSearchSource[] = [];
  for (const chunk of data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
    const url: string | undefined = chunk.web?.uri;
    if (url === undefined || url.length === 0) continue;
    sources.push({ title: chunk.web?.title ?? url, url });
  }
  return sources;
}

/** 按指定能力执行一次联网检索；不抛出，失败已由 requestGeminiResult 记日志。 */
export async function searchGeminiWeb(
  capability: AiWebSearchCapability,
  request: AiWebSearchRequest
): Promise<AiWebSearchResult> {
  const result: GeminiRequestResult = await requestGeminiResult(
    capability,
    (): GenerateContentParameters => {
      // web_search 没配时抛错，由 requestGeminiResult 的 try 归一成失败；text 取对话模型。
      const model: string = requireAgentCapabilityConfig(capability).model;
      return {
        model,
        contents: [{ role: "user", parts: [{ text: request.query }] }],
        config: {
          systemInstruction: request.instruction,
          tools: [{ googleSearch: {} }],
          maxOutputTokens: GEMINI_WEB_SEARCH_MAX_TOKENS,
          abortSignal: request.signal,
        },
      };
    },
    GEMINI_WEB_SEARCH_ERROR_LABEL
  );
  const response: GenerateContentResponse | undefined = result.response;
  const searchCalls: number = response === undefined ? 0 : countGoogleSearchCalls(response);

  if (!result.ok) return { ok: false, searchCalls };
  return {
    ok: true,
    text: responseText(result.response) ?? "",
    sources: groundedSources(result.response),
    searchCalls,
  };
}
