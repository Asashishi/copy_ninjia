/**
 * OpenAI 联网检索执行器：请求体挂 hosted web_search，来源取自 url_citation，检索次数在成功与
 * 「HTTP 成功但产出不可用」两条分支都计入；上报统一由客户端响应边界完成。
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type OpenAI from "openai";
import { installAiCacheUsageSink } from "../../../packages/infra/aiCacheUsage";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import type { OpenAiRequestResult } from "../../../packages/types/aiChat/openai";
import type { AiWebSearchResult } from "../../../packages/types/aiChat/provider";
import type { AgentCapability } from "../../../packages/types/config";

const requestOpenAiResult = mock(async (..._args: unknown[]): Promise<OpenAiRequestResult> => ({ ok: false, failureKind: "request" }));
mock.module("../../../packages/aiChat/openai/client", () => ({ requestOpenAiResult }));

const { searchOpenAiWeb } = await import("../../../packages/aiChat/openai/search");
const {
  OPENAI_STORE_RESPONSES,
  OPENAI_WEB_SEARCH_MAX_TOKENS,
} = await import("../../../packages/consts/aiChat/openai");

type ResponseBody = OpenAI.Responses.ResponseCreateParamsNonStreaming;

/** agent.json 的检索能力名，即用量记录与客户端缓存的能力键。 */
const WEB_SEARCH_CAPABILITY: AgentCapability = "web_search";
/** 没配 web_search 时 cron 摘要用来检索的对话能力名。 */
const TEXT_CAPABILITY: AgentCapability = "text";
/** OpenAI hosted 检索工具在请求体里的形态。 */
const HOSTED_WEB_SEARCH_TOOL: OpenAI.Responses.Tool = { type: "web_search" };

/** 一份带一次检索、两条引用的响应。 */
function searchedResponse(): OpenAI.Responses.Response {
  return {
    object: "response",
    status: "completed",
    output_text: "结论正文",
    output: [
      { type: "web_search_call", id: "ws_1", action: { type: "search" }, status: "completed" },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: "结论正文",
          annotations: [
            { type: "url_citation", url: "https://a.example/1", title: "甲", start_index: 0, end_index: 2 },
            { type: "url_citation", url: "https://b.example/2", title: "乙", start_index: 2, end_index: 4 },
          ],
        }],
      },
    ],
  } as unknown as OpenAI.Responses.Response;
}

const reported: AiCacheUsage[] = [];

beforeEach(() => {
  requestOpenAiResult.mockClear();
  reported.length = 0;
  installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
});
afterEach(() => installAiCacheUsageSink(null));

test("请求体挂 hosted web_search，按 web_search 能力的模型与调用方提示词发出", async () => {
  requestOpenAiResult.mockResolvedValueOnce({ ok: true, response: searchedResponse() });
  const signal: AbortSignal = new AbortController().signal;
  await searchOpenAiWeb(WEB_SEARCH_CAPABILITY, { instruction: "先检索", query: "今天的新闻", signal });

  const options = requestOpenAiResult.mock.calls[0]![0] as { capability: string; buildBody: () => ResponseBody; signal?: AbortSignal };
  expect(options.capability).toBe(WEB_SEARCH_CAPABILITY);
  expect(options.signal).toBe(signal);
  expect(options.buildBody()).toEqual({
    model: getAgentDeploymentConfig().webSearch!.model,
    instructions: "先检索",
    input: "今天的新闻",
    tools: [HOSTED_WEB_SEARCH_TOOL],
    max_output_tokens: OPENAI_WEB_SEARCH_MAX_TOKENS,
    store: OPENAI_STORE_RESPONSES,
  });
});

test("成功时交回正文、url_citation 来源与检索次数，执行器不重复上报用量", async () => {
  requestOpenAiResult.mockImplementationOnce(async (...args: unknown[]): Promise<OpenAiRequestResult> => {
    (args[0] as { buildBody: () => ResponseBody }).buildBody();
    return { ok: true, response: searchedResponse() };
  });
  const result: AiWebSearchResult = await searchOpenAiWeb(WEB_SEARCH_CAPABILITY, { instruction: "i", query: "q" });

  expect(result).toEqual({
    ok: true,
    text: "结论正文",
    sources: [{ title: "甲", url: "https://a.example/1" }, { title: "乙", url: "https://b.example/2" }],
    searchCalls: 1,
  });
  expect(reported).toEqual([]);
});

test("产出不可用时仍计入已执行的检索；请求失败时没有检索也不记", async () => {
  requestOpenAiResult.mockImplementationOnce(async (...args: unknown[]): Promise<OpenAiRequestResult> => {
    (args[0] as { buildBody: () => ResponseBody }).buildBody();
    return { ok: false, failureKind: "response", response: searchedResponse() };
  });
  expect(await searchOpenAiWeb(WEB_SEARCH_CAPABILITY, { instruction: "i", query: "q" })).toEqual({ ok: false, searchCalls: 1 });
  expect(reported).toEqual([]);

  requestOpenAiResult.mockResolvedValueOnce({ ok: false, failureKind: "request" });
  expect(await searchOpenAiWeb(WEB_SEARCH_CAPABILITY, { instruction: "i", query: "q" })).toEqual({ ok: false, searchCalls: 0 });
  expect(reported).toEqual([]);
});

test("text 能力的检索用对话模型，执行器不重复上报用量", async () => {
  requestOpenAiResult.mockImplementationOnce(async (...args: unknown[]): Promise<OpenAiRequestResult> => {
    expect((args[0] as { capability: string }).capability).toBe(TEXT_CAPABILITY);
    expect((args[0] as { buildBody: () => ResponseBody }).buildBody().model).toBe(getAgentDeploymentConfig().text.model);
    return { ok: true, response: searchedResponse() };
  });
  await searchOpenAiWeb(TEXT_CAPABILITY, { instruction: "i", query: "q" });
  expect(reported).toEqual([]);
});
