/**
 * Anthropic 联网检索执行器：按能力取模型，挂只许直接调用的内建检索；来源先取正文引用再补检索结果；
 * pause_turn 续发并合并正文与来源；成功与失败分支都交回已执行的检索次数，执行器不重复上报用量。
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { BetaFallbackState } from "@anthropic-ai/sdk";
import type { AnthropicRequestResult } from "../../../packages/types/aiChat/anthropic";
import type { AiCacheUsage } from "../../../packages/types/aiCache";
import type { AgentCapability } from "../../../packages/types/config";
import { getAgentDeploymentConfig } from "../../../packages/config/agent";
import { installAiCacheUsageSink } from "../../../packages/infra/aiCacheUsage";

/** agent.json 的检索能力名。 */
const WEB_SEARCH_CAPABILITY: AgentCapability = "web_search";
/** 没配 web_search 时 cron 摘要用来检索的对话能力名。 */
const TEXT_CAPABILITY: AgentCapability = "text";

const results: AnthropicRequestResult[] = [];
const calls: { capability: string; body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming }[] = [];
const fallbackStates: unknown[] = [];
const requestAnthropicMessage = mock(async (...args: unknown[]): Promise<AnthropicRequestResult> => {
  const options = args[0] as {
    capability: string;
    buildBody: () => Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
    fallbackState: unknown;
  };
  calls.push({ capability: options.capability, body: structuredClone(options.buildBody()) });
  fallbackStates.push(options.fallbackState);
  return results.shift() ?? { ok: false, failureKind: "request" };
});
mock.module("../../../packages/aiChat/anthropic/client", () => ({ requestAnthropicMessage }));

const { searchAnthropicWeb } = await import("../../../packages/aiChat/anthropic/search");
const {
  ANTHROPIC_WEB_SEARCH_MAX_TOKENS,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  ANTHROPIC_WEB_SEARCH_TOOL_TYPE,
} = await import("../../../packages/consts/aiChat/anthropic");

function message(content: unknown[], stopReason: string, searches: number): Anthropic.Beta.BetaMessage {
  return { content, stop_reason: stopReason, usage: { server_tool_use: { web_search_requests: searches } } } as unknown as Anthropic.Beta.BetaMessage;
}

const reported: AiCacheUsage[] = [];
beforeEach(() => {
  results.length = 0;
  calls.length = 0;
  fallbackStates.length = 0;
  reported.length = 0;
  installAiCacheUsageSink((usage: AiCacheUsage): void => { reported.push(usage); });
});
afterEach(() => installAiCacheUsageSink(null));

test("请求体挂只许直接调用的内建检索；来源先取引用、再补检索结果；执行器不重复上报用量", async () => {
  results.push({
    ok: true,
    message: message([
      { type: "server_tool_use", id: "s", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "s", content: [{ type: "web_search_result", url: "https://b.example", title: "乙" }] },
      { type: "text", text: "结论", citations: [{ type: "web_search_result_location", url: "https://a.example", title: null, cited_text: "x" }] },
    ], "end_turn", 1),
  });
  const result = await searchAnthropicWeb(WEB_SEARCH_CAPABILITY, { instruction: "先检索", query: "问题" });

  expect(result).toEqual({
    ok: true,
    text: "结论",
    sources: [{ title: "https://a.example", url: "https://a.example" }, { title: "乙", url: "https://b.example" }],
    searchCalls: 1,
  });
  expect(calls[0] as unknown).toEqual({
    capability: WEB_SEARCH_CAPABILITY,
    body: {
      model: getAgentDeploymentConfig().webSearch!.model,
      system: "先检索",
      messages: [{ role: "user", content: "问题" }],
      tools: [{ type: ANTHROPIC_WEB_SEARCH_TOOL_TYPE, name: ANTHROPIC_WEB_SEARCH_TOOL_NAME, allowed_callers: ["direct"] }],
      max_tokens: ANTHROPIC_WEB_SEARCH_MAX_TOKENS,
    },
  });
  expect(reported).toEqual([]);
});

test("text 能力用对话模型；pause_turn 续发后合并正文与来源，失败时如实交回已执行的检索次数", async () => {
  const paused: unknown[] = [{ type: "text", text: "前半", citations: [{ type: "web_search_result_location", url: "https://a.example", title: "甲", cited_text: "x" }] }];
  results.push(
    { ok: true, message: message(paused, "pause_turn", 1) },
    { ok: true, message: message([{ type: "text", text: "后半" }], "end_turn", 1) }
  );
  const result = await searchAnthropicWeb(TEXT_CAPABILITY, { instruction: "i", query: "q" });
  expect(result).toEqual({ ok: true, text: "前半后半", sources: [{ title: "甲", url: "https://a.example" }], searchCalls: 2 });
  expect(calls[0]!.capability).toBe(TEXT_CAPABILITY);
  expect(calls[0]!.body.model).toBe(getAgentDeploymentConfig().text.model);
  expect(calls[1]!.body.messages as unknown).toEqual([{ role: "user", content: "q" }, { role: "assistant", content: paused }]);
  expect(fallbackStates[0]).toBeInstanceOf(BetaFallbackState);
  expect(fallbackStates[1]).toBe(fallbackStates[0]);

  results.push({ ok: false, failureKind: "response", stopReason: "max_tokens", stopDetails: undefined, message: message([], "max_tokens", 3) });
  expect(await searchAnthropicWeb(TEXT_CAPABILITY, { instruction: "i", query: "q" })).toEqual({ ok: false, searchCalls: 3 });
});

test("拒答按带 refused 的失败交回并如实交回已执行的检索次数；其余失败不带 refused", async () => {
  results.push({ ok: false, failureKind: "refused", stopReason: "refusal", stopDetails: undefined, message: message([], "refusal", 1) });
  expect(await searchAnthropicWeb(WEB_SEARCH_CAPABILITY, { instruction: "i", query: "q" })).toEqual({ ok: false, searchCalls: 1, refused: true });
  results.push({ ok: false, failureKind: "request" });
  expect(await searchAnthropicWeb(WEB_SEARCH_CAPABILITY, { instruction: "i", query: "q" })).toEqual({ ok: false, searchCalls: 0 });
});

test("HTTP 成功但检索工具报错时失败，不把解释文字交作检索结论", async () => {
  results.push({ ok: true, message: message([
    { type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
    { type: "text", text: "无法联网" },
  ], "end_turn", 0) });
  expect(await searchAnthropicWeb(WEB_SEARCH_CAPABILITY, { instruction: "i", query: "q" }))
    .toEqual({ ok: false, searchCalls: 0 });
});

test("缺计量字段时只数成功的检索结果；未执行的调用与错误结果不计数", async () => {
  results.push({ ok: true, message: {
    content: [
      { type: "server_tool_use", id: "pending", name: "web_search", input: {} },
      { type: "web_search_tool_result", tool_use_id: "done", content: [] },
      { type: "text", text: "结论" },
    ],
    stop_reason: "end_turn",
    usage: {},
  } as unknown as Anthropic.Beta.BetaMessage });
  expect(await searchAnthropicWeb(TEXT_CAPABILITY, { instruction: "i", query: "q" }))
    .toMatchObject({ ok: true, searchCalls: 1 });
});
