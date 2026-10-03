/**
 * `web_search` 函数工具执行器：成功时交回限长的「提示语 + 结论 + 编号来源」，凡是未成功——
 * 入参不合法、超出每轮次数、请求失败、端点没检索、结论为空——都只回「模型搜索失败」并记一行
 * 不含检索问题的日志；本轮作废时不记。
 */

import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { TOKYO_TIME_ZONE } from "../../../packages/consts/time";
import type { AiWebSearchFacade, AiWebSearchRequest, AiWebSearchResult } from "../../../packages/types/aiChat/provider";
import type { WebSearchToolExecutor, WebSearchToolOutcome } from "../../../packages/types/aiChat/replies";

const loggerError = mock((..._args: unknown[]): void => {});
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError }) }));

const { createWebSearchExecutor, formatWebSearchResult } = await import("../../../packages/aiChat/ai/tools/webSearch");
const {
  WEB_SEARCH_FAILED_TEXT,
  WEB_SEARCH_MAX_SOURCES,
  WEB_SEARCH_QUERY_MAX_CHARS,
  WEB_SEARCH_RESULT_MAX_CHARS,
  WEB_SEARCH_RESULT_NOTICE,
  WEB_SEARCH_SOURCES_HEADING,
} = await import("../../../packages/consts/aiChat/tools");
const { WEB_SEARCH_EXECUTOR_INSTRUCTION } = await import("../../../packages/consts/aiChat/prompts/search");

const FAILED: string = JSON.stringify({ error: WEB_SEARCH_FAILED_TEXT });
/** 测试构造的本轮调用上限。 */
const TEST_MAX_CALLS_PER_USE: number = 7;

/** 记下每次请求、按队列交回结果的替身门面。 */
function fakeProvider(results: AiWebSearchResult[]): { provider: AiWebSearchFacade; requests: AiWebSearchRequest[] } {
  const requests: AiWebSearchRequest[] = [];
  return {
    requests,
    provider: {
      name: "google",
      async searchWeb(request: AiWebSearchRequest): Promise<AiWebSearchResult> {
        requests.push(request);
        return results.shift() ?? { ok: true, text: "结论", sources: [], searchCalls: 1 };
      },
    },
  };
}

function resultText(outcome: WebSearchToolOutcome): string {
  return (JSON.parse(outcome.result) as { result: string }).result;
}

beforeEach(() => loggerError.mockClear());
afterEach(() => setSystemTime());

test("成功：按固定提示词转交检索问题，交回提示语、结论与编号来源及检索次数", async () => {
  setSystemTime(new Date("2026-10-03T04:00:00.000Z"));
  const signal: AbortSignal = new AbortController().signal;
  const { provider, requests } = fakeProvider([{
    ok: true,
    text: "  今天东京晴。  ",
    sources: [{ title: "天气\n预报", url: "https://a.example/1" }],
    searchCalls: 2,
  }]);
  const execute: WebSearchToolExecutor = createWebSearchExecutor(provider, TEST_MAX_CALLS_PER_USE, signal);
  const outcome: WebSearchToolOutcome = await execute(JSON.stringify({ query: "  东京天气  " }));

  expect(requests).toHaveLength(1);
  expect(requests[0]!.query).toStartWith("东京天气\n检索基准时间：");
  expect(requests[0]!.query).toContain(TOKYO_TIME_ZONE);
  expect(requests[0]!.query).toContain("2026年10月3日");
  expect(requests[0]!.query.match(/检索基准时间：/g)).toHaveLength(1);
  expect(requests[0]!.signal).toBe(signal);
  expect(requests[0]!.instruction).toBe(WEB_SEARCH_EXECUTOR_INSTRUCTION);
  expect(outcome.searchCalls).toBe(2);
  expect(resultText(outcome)).toBe(
    `${WEB_SEARCH_RESULT_NOTICE}\n今天东京晴。\n${WEB_SEARCH_SOURCES_HEADING}\n1. 天气 预报 https://a.example/1`
  );
  expect(loggerError).not.toHaveBeenCalled();
});

test("未成功的各种情形一律只回「模型搜索失败」，检索次数如实交回", async () => {
  const { provider, requests } = fakeProvider([
    { ok: false, searchCalls: 1 },
    { ok: true, text: "凭空写的", sources: [], searchCalls: 0 },
    { ok: true, text: "   ", sources: [], searchCalls: 1 },
  ]);
  const execute: WebSearchToolExecutor = createWebSearchExecutor(provider, TEST_MAX_CALLS_PER_USE, undefined);

  expect(await execute("not json")).toEqual({ result: FAILED, searchCalls: 0 });
  expect(await execute(JSON.stringify({ query: "  " }))).toEqual({ result: FAILED, searchCalls: 0 });
  expect(await execute(JSON.stringify({ query: "x".repeat(WEB_SEARCH_QUERY_MAX_CHARS + 1) }))).toEqual({ result: FAILED, searchCalls: 0 });
  expect(requests).toHaveLength(0);
  expect(await execute(JSON.stringify({ query: "a" }))).toEqual({ result: FAILED, searchCalls: 1 });
  expect(await execute(JSON.stringify({ query: "b" }))).toEqual({ result: FAILED, searchCalls: 0 });
  expect(loggerError).toHaveBeenCalledTimes(5);
  // 日志只写原因，不写检索问题。
  for (const [message] of loggerError.mock.calls) expect(String(message)).not.toContain("凭空写的");
});

test.each([1, TEST_MAX_CALLS_PER_USE])("每轮按配置最多调用 %i 次，超出时不发请求；新一轮重新计数", async (maxCallsPerUse: number) => {
  const { provider, requests } = fakeProvider([]);
  const execute: WebSearchToolExecutor = createWebSearchExecutor(provider, maxCallsPerUse, undefined);
  for (let index: number = 0; index < maxCallsPerUse; index++) {
    expect((await execute(JSON.stringify({ query: `q${index}` }))).searchCalls).toBe(1);
  }
  expect(await execute(JSON.stringify({ query: "over" }))).toEqual({ result: FAILED, searchCalls: 0 });
  expect(requests).toHaveLength(maxCallsPerUse);
  // 新的一轮回复重新计数。
  expect((await createWebSearchExecutor(provider, maxCallsPerUse, undefined)(JSON.stringify({ query: "next" }))).searchCalls).toBe(1);
});

test("按函数调用次数扣额度，不按供应商内部执行的检索次数扣额度；非法调用也占一次", async () => {
  const maxCallsPerUse: number = 2;
  const { provider, requests } = fakeProvider([{ ok: true, text: "结论", sources: [], searchCalls: 10 }]);
  const execute: WebSearchToolExecutor = createWebSearchExecutor(provider, maxCallsPerUse, undefined);
  expect((await execute(JSON.stringify({ query: "q" }))).searchCalls).toBe(10);
  expect(await execute("not json")).toEqual({ result: FAILED, searchCalls: 0 });
  expect(await execute(JSON.stringify({ query: "over" }))).toEqual({ result: FAILED, searchCalls: 0 });
  expect(requests).toHaveLength(1);
});

test("本轮已作废时同样回失败，但不记日志", async () => {
  const controller: AbortController = new AbortController();
  controller.abort();
  const { provider } = fakeProvider([{ ok: false, searchCalls: 0 }]);
  expect(await createWebSearchExecutor(provider, TEST_MAX_CALLS_PER_USE, controller.signal)(JSON.stringify({ query: "q" })))
    .toEqual({ result: FAILED, searchCalls: 0 });
  expect(loggerError).not.toHaveBeenCalled();
});

test("结果裁剪：来源按地址去重、最多 WEB_SEARCH_MAX_SOURCES 条，来源超过总上限一半时从末尾丢弃，总长不超上限", () => {
  const sources = Array.from({ length: WEB_SEARCH_MAX_SOURCES + 3 }, (_unused: unknown, index: number) => ({
    title: `标题${index}`,
    url: `https://s.example/${index % (WEB_SEARCH_MAX_SOURCES + 1)}`,
  }));
  const short: string = formatWebSearchResult("结论。", sources);
  expect(short.split("\n").filter((line: string): boolean => /^\d+\. /.test(line))).toHaveLength(WEB_SEARCH_MAX_SOURCES);
  expect(short).not.toContain(`https://s.example/${WEB_SEARCH_MAX_SOURCES}`);

  const longUrls = Array.from({ length: WEB_SEARCH_MAX_SOURCES }, (_unused: unknown, index: number) => ({
    title: "t",
    url: `https://long.example/${index}/${"x".repeat(WEB_SEARCH_RESULT_MAX_CHARS / 4)}`,
  }));
  const trimmed: string = formatWebSearchResult("长。".repeat(WEB_SEARCH_RESULT_MAX_CHARS), longUrls);
  expect(trimmed.length).toBeLessThanOrEqual(WEB_SEARCH_RESULT_MAX_CHARS);
  expect(trimmed.slice(trimmed.indexOf(`\n${WEB_SEARCH_SOURCES_HEADING}`)).length).toBeLessThanOrEqual(WEB_SEARCH_RESULT_MAX_CHARS / 2);
  expect(trimmed).toContain("1. t https://long.example/0/");

  const noSources: string = formatWebSearchResult("只有结论", []);
  expect(noSources).toBe(`${WEB_SEARCH_RESULT_NOTICE}\n只有结论`);
});
