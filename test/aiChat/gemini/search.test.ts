/**
 * Gemini 联网检索执行器：请求体挂 googleSearch，来源取自 groundingChunks，检索次数在成功与
 * 「HTTP 成功但产出不可用」两条分支都计入并上报。
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { FinishReason } from "@google/genai";
import type { GenerateContentResponse } from "@google/genai";
import { installAiCacheUsageSink } from "../../../packages/infra/aiCacheUsage";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import type { GeminiRequestResult } from "../../../packages/types/aiChat/gemini";
import type { GeminiRequestOptions } from "../../../packages/aiChat/gemini/client";
import type { AgentCapability } from "../../../packages/types/config";

/** agent.json 的检索能力名，即用量记录与客户端缓存的能力键。 */
const WEB_SEARCH_CAPABILITY: AgentCapability = "web_search";
/** 没配 web_search 时 cron 摘要用来检索的对话能力名。 */
const TEXT_CAPABILITY: AgentCapability = "text";

const requestGeminiResult = mock(async (..._args: unknown[]): Promise<GeminiRequestResult> => ({ ok: false, failureKind: "request" }));
mock.module("../../../packages/aiChat/gemini/client", () => ({ requestGeminiResult }));

const { searchGeminiWeb } = await import("../../../packages/aiChat/gemini/search");
const { GEMINI_WEB_SEARCH_MAX_TOKENS } = await import("../../../packages/consts/aiChat/gemini");

/** 一份检索过两次、带三个 grounding 来源（其中一个没有地址）的响应。 */
function groundedResponse(): GenerateContentResponse {
  return {
    candidates: [{
      finishReason: FinishReason.STOP,
      content: { role: "model", parts: [{ text: "结论" }, { text: "正文" }] },
      groundingMetadata: {
        webSearchQueries: ["a", "b"],
        groundingChunks: [
          { web: { uri: "https://a.example/1", title: "a.example" } },
          { web: { title: "无地址" } },
          { web: { uri: "https://b.example/2" } },
        ],
      },
    }],
  } as GenerateContentResponse;
}

const reported: AiCacheUsage[] = [];

beforeEach(() => {
  requestGeminiResult.mockClear();
  reported.length = 0;
  installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
});
afterEach(() => installAiCacheUsageSink(null));

test("请求体挂 googleSearch，按 web_search 能力的模型与调用方提示词发出", async () => {
  requestGeminiResult.mockResolvedValueOnce({ ok: true, response: groundedResponse() });
  const signal: AbortSignal = new AbortController().signal;
  await searchGeminiWeb(WEB_SEARCH_CAPABILITY, { instruction: "先检索", query: "今天的新闻", signal });

  const { capability, buildBody } = requestGeminiResult.mock.calls[0]![0] as GeminiRequestOptions;
  expect(capability).toBe(WEB_SEARCH_CAPABILITY);
  expect(buildBody()).toEqual({
    model: getAgentDeploymentConfig().webSearch!.model,
    contents: [{ role: "user", parts: [{ text: "今天的新闻" }] }],
    config: {
      systemInstruction: "先检索",
      tools: [{ googleSearch: {} }],
      maxOutputTokens: GEMINI_WEB_SEARCH_MAX_TOKENS,
      abortSignal: signal,
    },
  });
});

test("成功时交回正文、带地址的来源（缺标题以地址代替）与检索次数，执行器不重复上报用量", async () => {
  requestGeminiResult.mockImplementationOnce(async (...args: unknown[]): Promise<GeminiRequestResult> => {
    (args[0] as GeminiRequestOptions).buildBody();
    return { ok: true, response: groundedResponse() };
  });
  expect(await searchGeminiWeb(WEB_SEARCH_CAPABILITY, { instruction: "i", query: "q" })).toEqual({
    ok: true,
    text: "结论正文",
    sources: [
      { title: "a.example", url: "https://a.example/1" },
      { title: "https://b.example/2", url: "https://b.example/2" },
    ],
    searchCalls: 2,
  });
  expect(reported).toEqual([]);
});

test("产出不可用时仍计入已执行的检索；请求失败时没有检索也不记", async () => {
  requestGeminiResult.mockImplementationOnce(async (...args: unknown[]): Promise<GeminiRequestResult> => {
    (args[0] as GeminiRequestOptions).buildBody();
    return { ok: false, failureKind: "response", finishReason: FinishReason.MAX_TOKENS, response: groundedResponse() };
  });
  expect(await searchGeminiWeb(WEB_SEARCH_CAPABILITY, { instruction: "i", query: "q" })).toEqual({ ok: false, searchCalls: 2 });
  expect(reported).toEqual([]);

  requestGeminiResult.mockResolvedValueOnce({ ok: false, failureKind: "request" });
  expect(await searchGeminiWeb(WEB_SEARCH_CAPABILITY, { instruction: "i", query: "q" })).toEqual({ ok: false, searchCalls: 0 });
  expect(reported).toEqual([]);
});

test("text 能力的检索用对话模型，执行器不重复上报用量", async () => {
  requestGeminiResult.mockImplementationOnce(async (...args: unknown[]): Promise<GeminiRequestResult> => {
    expect((args[0] as GeminiRequestOptions).capability).toBe(TEXT_CAPABILITY);
    expect((args[0] as GeminiRequestOptions).buildBody().model).toBe(getAgentDeploymentConfig().text.model);
    return { ok: true, response: groundedResponse() };
  });
  await searchGeminiWeb(TEXT_CAPABILITY, { instruction: "i", query: "q" });
  expect(reported).toEqual([]);
});
