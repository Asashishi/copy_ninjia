/**
 * cron 摘要的两段式组稿：检索优先走 web_search、没配时走 text 内建检索；未检索时把模型
 * 正文加警示后发送，已检索时同时核对正文链接与来源元数据，两处都没来源不组稿；组稿产出不合格时带诊断重试
 * 一次，仍不合格就判失败；成功交回能被 Telegram 解析的 MarkdownV2 原文。
 */

import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { loggerStub } from "../../helpers/loggerMock";
import { parseMarkdownV2 } from "../../helpers/markdownV2";
import { TOKYO_TIME_ZONE } from "../../../packages/consts/time";
import type {
  AiJsonRequest,
  AiStructuredTextProvider,
  AiTextResult,
  AiWebSearchFacade,
  AiWebSearchRequest,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../../packages/types/aiChat/provider";
import type { WebDigestCompositionResult, WebDigestRequest } from "../../../packages/types/webDigest";

const searchRequests: { via: string; request: AiWebSearchRequest }[] = [];
const searchResults: AiWebSearchResult[] = [];
const composeRequests: AiJsonRequest[] = [];
const composeResults: AiTextResult[] = [];
let webSearchConfigured: boolean = true;
let onSearch: (() => void) | null = null;

function searcher(via: string): AiWebSearchFacade {
  return {
    name: "google",
    async searchWeb(request: AiWebSearchRequest): Promise<AiWebSearchResult> {
      searchRequests.push({ via, request });
      const result: AiWebSearchResult = searchResults.shift() ?? { ok: false, searchCalls: 0 };
      onSearch?.();
      return result;
    },
  };
}
const composer: AiStructuredTextProvider = {
  name: "openai",
  async generateJson(request: AiJsonRequest): Promise<AiTextResult> {
    composeRequests.push(request);
    return composeResults.shift() ?? { ok: false, retryable: false };
  },
};
const loggerError = mock((..._args: unknown[]): void => {});
const loggerWarn = mock((..._args: unknown[]): void => {});
mock.module("../../../packages/aiChat/provider", () => ({
  webSearchAiProvider: (): AiWebSearchFacade | null => webSearchConfigured ? searcher("web_search") : null,
  textWebSearchAiProvider: (): AiWebSearchFacade => searcher("text"),
  structuredTextAiProvider: (): AiStructuredTextProvider => composer,
}));
mock.module("../../../packages/infra/logger", () => ({ logger: loggerStub({ error: loggerError, warn: loggerWarn }) }));

const { composeWebDigest } = await import("../../../packages/aiChat/ai/webDigest");
const {
  WEB_DIGEST_COMPOSE_ATTEMPTS,
  WEB_DIGEST_JSON_SCHEMA,
  WEB_DIGEST_MAX_SOURCES,
  WEB_DIGEST_NO_SEARCH_LOG_MAX_CHARS,
  WEB_DIGEST_UNSEARCHED_WARNING,
} = await import("../../../packages/consts/webDigest");
const { WEB_DIGEST_COMPOSE_INSTRUCTION } = await import("../../../packages/consts/aiChat/prompts/webDigest");
const { TELEGRAM_MESSAGE_MAX_CHARS } = await import("../../../packages/consts/telegram");

const REQUEST: WebDigestRequest = { topic: "今日科技新闻", language: "zh", maxItems: 2, instructions: "优先查一手来源；每条正文只写一句" };
const SOURCE_URL: string = "https://a.example/news";
const RESEARCH: AiWebSearchResult = {
  ok: true,
  text: "检索整理的要点",
  sources: [{ title: "甲", url: SOURCE_URL }, { title: "甲重复", url: SOURCE_URL }, { title: "乙", url: "https://b.example/2" }],
  searchCalls: 1,
};

function digestJson(url: string = SOURCE_URL, body: string = "正文。"): string {
  return JSON.stringify({
    title: "今日科技新闻",
    sections: [{ heading: "AI", items: [{ title: "新模型", body, source: "甲", url }] }],
  });
}

beforeEach(() => {
  searchRequests.length = 0;
  searchResults.length = 0;
  composeRequests.length = 0;
  composeResults.length = 0;
  webSearchConfigured = true;
  onSearch = null;
  loggerError.mockClear();
  loggerWarn.mockClear();
});
afterEach(() => setSystemTime());

test("配了 web_search 时用它检索；组稿拿到去重后的来源列表，交回可被 Telegram 解析的 MarkdownV2", async () => {
  setSystemTime(new Date("2026-10-03T04:00:00.000Z"));
  searchResults.push(RESEARCH);
  composeResults.push({ ok: true, text: digestJson() });
  const signal: AbortSignal = new AbortController().signal;
  const result: WebDigestCompositionResult = await composeWebDigest(REQUEST, signal);

  expect(result.ok).toBeTrue();
  expect(parseMarkdownV2(result.ok ? result.text : "").text).toStartWith("今日科技新闻\n\nAI\n\n1. 新模型");
  expect(searchRequests).toHaveLength(1);
  expect(searchRequests[0]!.via).toBe("web_search");
  expect(searchRequests[0]!.request.query).toStartWith(`主题：${REQUEST.topic}\n任务规则：${REQUEST.instructions}\n检索基准时间：`);
  expect(searchRequests[0]!.request.query).toContain(TOKYO_TIME_ZONE);
  expect(searchRequests[0]!.request.query).toContain("2026年10月3日");
  expect(searchRequests[0]!.request.query.match(/检索基准时间：/g)).toHaveLength(1);
  expect(searchRequests[0]!.request.instruction).toContain(`最多整理 ${REQUEST.maxItems} 件事`);
  expect(searchRequests[0]!.request.instruction).toContain("优先使用提供的联网检索工具");
  expect(searchRequests[0]!.request.instruction).toContain("未调用检索工具时也直接给出当前能提供的内容");
  expect(searchRequests[0]!.request.instruction).not.toContain("未执行联网检索");
  expect(searchRequests[0]!.request.instruction).not.toContain("必须实际调用");
  expect(searchRequests[0]!.request.instruction).toContain("日期不明的项目不列");
  expect(searchRequests[0]!.request.instruction).not.toContain(REQUEST.instructions!);
  expect(searchRequests[0]!.request.instruction).not.toContain("JSON");
  expect(searchRequests[0]!.request.instruction).not.toContain("你是联网检索助手");
  expect(searchRequests[0]!.request.signal).toBe(signal);
  const compose: AiJsonRequest = composeRequests[0]!;
  expect(compose.systemPrompt).toBe(WEB_DIGEST_COMPOSE_INSTRUCTION);
  expect(compose.systemPrompt).toContain("事实只依据用户消息里的【检索结果】与【来源列表】");
  // 组稿提示必须交代链接取自检索结果或来源列表，并说明 JSON 字符串里的换行转义，
  // 正文里的平台换行与完整链接才能原样落进摘要（见下面两组行为用例）。
  expect(compose.systemPrompt).toContain("【检索结果】中的完整链接或【来源列表】");
  expect(compose.systemPrompt).toContain("JSON 字符串中的转义序列 \\n");
  expect(compose.systemPrompt).not.toContain("调用提供的联网检索工具");
  expect(compose.jsonSchema).toBe(WEB_DIGEST_JSON_SCHEMA);
  expect(compose.userContent).toContain(`主题：${REQUEST.topic}`);
  expect(compose.userContent).toContain(`任务规则：${REQUEST.instructions}`);
  expect(compose.userContent).toContain(`1. 甲 ${SOURCE_URL}\n2. 乙 https://b.example/2`);
  expect(compose.userContent).toContain("2026年10月3日");
  expect(compose.userContent.match(/检索基准时间：/g)).toHaveLength(1);
  expect(compose.userContent).not.toContain("甲重复");
  expect(compose.userContent).not.toContain("【上一次的问题】");
});

test("没配 web_search 时改用 text 模型的内建检索", async () => {
  webSearchConfigured = false;
  searchResults.push(RESEARCH);
  composeResults.push({ ok: true, text: digestJson() });
  expect((await composeWebDigest(REQUEST, new AbortController().signal)).ok).toBeTrue();
  expect(searchRequests[0]!.via).toBe("text");
});

test("未配置任务规则时检索问题只含短主题与可信时间", async () => {
  searchResults.push(RESEARCH);
  composeResults.push({ ok: true, text: digestJson() });
  const request: WebDigestRequest = { ...REQUEST, instructions: undefined };
  expect((await composeWebDigest(request, new AbortController().signal)).ok).toBeTrue();
  expect(searchRequests[0]!.request.query).toStartWith(`主题：${request.topic}\n检索基准时间：`);
  expect(searchRequests[0]!.request.query).not.toContain("任务规则：");
  expect(composeRequests[0]!.userContent).not.toContain("任务规则：");
});

test("联网搜索汇总组稿保留正文中的平台换行", async () => {
  const body: string = "Netflix 第3集 · 00:00 JST（预计）\nU-NEXT 第3集 · 时间待确认（预计）";
  searchResults.push(RESEARCH);
  composeResults.push({ ok: true, text: digestJson(SOURCE_URL, body) });
  const result: WebDigestCompositionResult = await composeWebDigest(REQUEST, new AbortController().signal);
  expect(result.ok).toBeTrue();
  expect(parseMarkdownV2(result.ok ? result.text : "").text).toContain(body);
  expect(composeRequests[0]!.systemPrompt).toBe(WEB_DIGEST_COMPOSE_INSTRUCTION);
});

test.each([
  ["裸链接", `${SOURCE_URL}。`, SOURCE_URL],
  ["Markdown 链接", `[官方公告](${SOURCE_URL}).`, SOURCE_URL],
  ["JSON 链接", JSON.stringify({ url: SOURCE_URL }), SOURCE_URL],
  ["尖括号链接", `<${SOURCE_URL}>`, SOURCE_URL],
  ["带括号与查询的链接", "[官方](https://a.example/news_(part_1)?episode=3&platform=nico#today)", "https://a.example/news_(part_1)?episode=3&platform=nico#today"],
  ["显式链接的末尾标点", "[官方](https://a.example/news!)", "https://a.example/news!"],
  ["IPv6 链接", "[官方](https://[2001:db8::1]/news)", "https://[2001:db8::1]/news"],
  ["含单引号的 Markdown 链接", "[官方](https://a.example/news?title=JoJo's)", "https://a.example/news?title=JoJo's"],
  ["含单引号的裸链接", "https://a.example/news?title=JoJo's。", "https://a.example/news?title=JoJo's"],
  ["单引号包围的链接", `'${SOURCE_URL}'.`, SOURCE_URL],
] as const)("仅正文带%s时保留完整地址，不误判 no sources", async (_format, text, url) => {
  searchResults.push({ ok: true, text, sources: [], searchCalls: 1 });
  composeResults.push({ ok: true, text: digestJson(url) });
  const result: WebDigestCompositionResult = await composeWebDigest(REQUEST, new AbortController().signal);
  expect(result.ok).toBeTrue();
  expect(parseMarkdownV2(result.ok ? result.text : "").entities).toContainEqual(expect.objectContaining({ type: "text_link", url }));
  expect(composeRequests).toHaveLength(1);
  expect(composeRequests[0]!.userContent).toContain(text);
  expect(composeRequests[0]!.systemPrompt).toBe(WEB_DIGEST_COMPOSE_INSTRUCTION);
  expect(loggerError).not.toHaveBeenCalled();
  expect(loggerWarn).not.toHaveBeenCalled();
});

test("来源列表达到上限时仍保留正文里的额外链接", async () => {
  const sources: readonly AiWebSearchSource[] = Array.from({ length: WEB_DIGEST_MAX_SOURCES + 1 }, (_value: unknown, index: number): AiWebSearchSource => ({
    title: `来源${index}`, url: `https://metadata.example/${index}`,
  }));
  const text: string = `官方作品页 ${SOURCE_URL}`;
  searchResults.push({ ok: true, text, sources, searchCalls: 1 });
  composeResults.push({ ok: true, text: digestJson() });
  const result: WebDigestCompositionResult = await composeWebDigest(REQUEST, new AbortController().signal);
  expect(result.ok).toBeTrue();
  expect(parseMarkdownV2(result.ok ? result.text : "").entities).toContainEqual(expect.objectContaining({ type: "text_link", url: SOURCE_URL }));
  expect(composeRequests[0]!.userContent).toContain(text);
  expect(composeRequests[0]!.userContent).not.toContain(sources[WEB_DIGEST_MAX_SOURCES]!.url);
});

test.each(["http://a.example/news", "https://", "https://user:password@a.example/news"])(
  "正文只有不合格链接 %s 时不能充当摘要来源",
  async (text: string) => {
    searchResults.push({ ok: true, text, sources: [], searchCalls: 1 });
    expect(await composeWebDigest(REQUEST, new AbortController().signal)).toEqual({ ok: false, reason: "no sources" });
    expect(composeRequests).toHaveLength(0);
  }
);

test("组稿不能把正文链接的前缀当作完整来源地址", async () => {
  searchResults.push({ ok: true, text: `${SOURCE_URL}-other`, sources: [], searchCalls: 1 });
  composeResults.push({ ok: true, text: digestJson() }, { ok: true, text: digestJson() });
  expect(await composeWebDigest(REQUEST, new AbortController().signal)).toEqual({ ok: false, reason: "invalid digest" });
});

test.each([
  ["search failed", { ok: false, searchCalls: 1 }],
  ["no sources", { ok: true, text: "要点", sources: [], searchCalls: 1 }],
] as const)("检索段 %s 时不组稿，判本轮失败", async (reason, research) => {
  searchResults.push(research as AiWebSearchResult);
  expect(await composeWebDigest(REQUEST, new AbortController().signal)).toEqual({ ok: false, reason });
  expect(composeRequests).toHaveLength(0);
  expect(loggerError).toHaveBeenCalledTimes(1);
});

test.each([0, 1])("检索请求失败时搜索次数 %s 不改变失败分类", async (searchCalls: number) => {
  searchResults.push({ ok: false, searchCalls });
  expect(await composeWebDigest(REQUEST, new AbortController().signal)).toEqual({ ok: false, reason: "search failed" });
  expect(searchRequests).toHaveLength(1);
  expect(composeRequests).toHaveLength(0);
  expect(loggerWarn).not.toHaveBeenCalled();
});

test("未调用搜索时直接发送带警示的模型正文，不要求来源也不组稿", async () => {
  const signal: AbortSignal = new AbortController().signal;
  const response: string = "*未核实*的排期\nNetflix 第3集 [来源](https://example.com)";
  searchResults.push({ ok: true, text: response, sources: [], searchCalls: 0 });
  const result: WebDigestCompositionResult = await composeWebDigest(REQUEST, signal);
  expect(result.ok).toBeTrue();
  expect(parseMarkdownV2(result.ok ? result.text : "").text).toBe(`${WEB_DIGEST_UNSEARCHED_WARNING}\n\n${response}`);
  expect(searchRequests).toHaveLength(1);
  expect(searchRequests[0]!.request.signal).toBe(signal);
  expect(composeRequests).toHaveLength(0);
  expect(loggerWarn).toHaveBeenCalledWith(
    `Web digest research answered without searching; sending with warning: response=${JSON.stringify(response)}; ` +
      `responseLength=${response.length}; truncated=false; sourceCount=0; messageTruncated=false.`
  );
  expect(loggerError).not.toHaveBeenCalled();
});

test("未调用搜索时即使供应商附来源也直接发送带警示的正文", async () => {
  searchResults.push({ ok: true, text: "当前资料", sources: [{ title: "甲", url: SOURCE_URL }], searchCalls: 0 });
  const result: WebDigestCompositionResult = await composeWebDigest(REQUEST, new AbortController().signal);
  expect(parseMarkdownV2(result.ok ? result.text : "").text).toBe(`${WEB_DIGEST_UNSEARCHED_WARNING}\n\n当前资料`);
  expect(searchRequests).toHaveLength(1);
  expect(composeRequests).toHaveLength(0);
  expect(loggerWarn).toHaveBeenCalledTimes(1);
});

test("未搜索正文超过 Telegram 上限时保留警示并安全截断，日志只预览固定长度", async () => {
  const response: string = "x".repeat(TELEGRAM_MESSAGE_MAX_CHARS + WEB_DIGEST_NO_SEARCH_LOG_MAX_CHARS);
  searchResults.push({ ok: true, text: response, sources: [], searchCalls: 0 });
  const result: WebDigestCompositionResult = await composeWebDigest(REQUEST, new AbortController().signal);
  const visible: string = parseMarkdownV2(result.ok ? result.text : "").text;
  expect(visible).toStartWith(`${WEB_DIGEST_UNSEARCHED_WARNING}\n\n`);
  expect(visible.length).toBe(TELEGRAM_MESSAGE_MAX_CHARS);
  expect(visible).toEndWith("…");
  expect(loggerWarn).toHaveBeenCalledWith(
    `Web digest research answered without searching; sending with warning: ` +
      `response=${JSON.stringify(response.slice(0, WEB_DIGEST_NO_SEARCH_LOG_MAX_CHARS))}; ` +
      `responseLength=${response.length}; truncated=true; sourceCount=0; messageTruncated=true.`
  );
});

test("未搜索正文在 emoji 中间达到长度限制时不留下孤立代理码元", async () => {
  const bodyLimit: number = TELEGRAM_MESSAGE_MAX_CHARS - WEB_DIGEST_UNSEARCHED_WARNING.length - 2;
  const response: string = `${"x".repeat(bodyLimit - 2)}😀z`;
  searchResults.push({ ok: true, text: response, sources: [], searchCalls: 0 });
  const result: WebDigestCompositionResult = await composeWebDigest(REQUEST, new AbortController().signal);
  const visible: string = parseMarkdownV2(result.ok ? result.text : "").text;
  expect(visible).toEndWith("x…");
  expect(visible).not.toContain("😀");
  expect(visible.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
});

test("未搜索且模型没有正文时按请求失败处理", async () => {
  searchResults.push({ ok: true, text: "  ", sources: [], searchCalls: 0 });
  expect(await composeWebDigest(REQUEST, new AbortController().signal)).toEqual({ ok: false, reason: "search failed" });
  expect(searchRequests).toHaveLength(1);
  expect(composeRequests).toHaveLength(0);
  expect(loggerError).toHaveBeenCalledWith("Web digest composition failed (search failed): the endpoint returned no text.");
});

test("未搜索正文返回后取消，不发送也不记日志", async () => {
  const controller: AbortController = new AbortController();
  searchResults.push({ ok: true, text: "凭空排期", sources: [], searchCalls: 0 });
  onSearch = (): void => controller.abort();
  expect(await composeWebDigest(REQUEST, controller.signal)).toEqual({ ok: false, reason: "aborted" });
  expect(searchRequests).toHaveLength(1);
  expect(loggerWarn).not.toHaveBeenCalled();
  expect(loggerError).not.toHaveBeenCalled();
});

test("首次产出不合格时带着诊断重试一次，第二次合格即成功", async () => {
  searchResults.push(RESEARCH);
  composeResults.push({ ok: true, text: "不是 JSON" }, { ok: true, text: digestJson() });
  expect((await composeWebDigest(REQUEST, new AbortController().signal)).ok).toBeTrue();
  expect(composeRequests).toHaveLength(WEB_DIGEST_COMPOSE_ATTEMPTS);
  expect(composeRequests[1]!.userContent).toContain("【上一次的问题】\nthe output was not a valid JSON object");
});

test("来源不在列表里的地址重试后仍不合格，判 invalid digest", async () => {
  searchResults.push(RESEARCH);
  composeResults.push({ ok: true, text: digestJson("https://made-up.example") }, { ok: true, text: digestJson("https://made-up.example") });
  expect(await composeWebDigest(REQUEST, new AbortController().signal)).toEqual({ ok: false, reason: "invalid digest" });
  expect(composeRequests[1]!.userContent).toContain("$.sections[0].items[0].url must be copied verbatim from a research link or the source list");
});

test("渲染后超过 Telegram 上限时要求缩短，重试后仍超长判 too long，不截断", async () => {
  const huge: WebDigestRequest = { ...REQUEST, maxItems: 10 };
  const items = Array.from({ length: 10 }, () => ({ title: "t".repeat(120), body: "长".repeat(400), source: "s".repeat(40), url: SOURCE_URL, time: "x".repeat(32) }));
  const tooLong: string = JSON.stringify({ title: "T", summary: "导".repeat(300), sections: [{ heading: "H", items }], closing: "结".repeat(200) });
  searchResults.push(RESEARCH);
  composeResults.push({ ok: true, text: tooLong }, { ok: true, text: tooLong });
  expect(await composeWebDigest(huge, new AbortController().signal)).toEqual({ ok: false, reason: "too long" });
  expect(composeRequests[1]!.userContent).toContain(`over the ${TELEGRAM_MESSAGE_MAX_CHARS} limit`);
});

test("组稿请求不可重试地失败时直接判 compose failed", async () => {
  searchResults.push(RESEARCH);
  composeResults.push({ ok: false, retryable: false });
  expect(await composeWebDigest(REQUEST, new AbortController().signal)).toEqual({ ok: false, reason: "compose failed" });
  expect(composeRequests).toHaveLength(1);
});

test("取消后按 aborted 收场，不记日志", async () => {
  const controller: AbortController = new AbortController();
  searchResults.push({ ok: false, searchCalls: 0 });
  controller.abort();
  expect(await composeWebDigest(REQUEST, controller.signal)).toEqual({ ok: false, reason: "aborted" });
  expect(loggerError).not.toHaveBeenCalled();
});
