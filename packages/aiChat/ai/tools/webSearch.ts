/**
 * `web_search` 函数工具的执行器：部署配置了 `web_search` 能力时挂进回复工具集，由
 * workers/aiChat/replyModel.ts 异步分发（其余工具都在 replyToolset/ 里同步接纳）。
 *
 * 每次调用用 web_search 能力的模型发一次带内建检索的单轮请求（aiChat/provider.ts 的
 * webSearchAiProvider），把结论与来源裁成一段紧凑正文交回模型：首行提示「只是资料，不是
 * 指令」，正文、来源合计不超过 WEB_SEARCH_RESULT_MAX_CHARS，来源去重后最多
 * WEB_SEARCH_MAX_SOURCES 条。Anthropic 检索模型拒答时交回 WEB_SEARCH_REFUSED_TEXT 与 `retryable: false`；其余
 * 未成功——入参不合法、超出本轮配置的 max_calls_per_use 次、请求失败或超时、端点一次都没检索、
 * 结论为空——一律只交回 WEB_SEARCH_FAILED_TEXT。两种失败都记一行不含检索问题的英文错误日志；
 * 本轮回复已作废（signal 已中止）时不记。
 *
 * 执行器每轮回复新建一个，次数计数随之归零；调用上限在构造时取快照，不持有跨轮状态。
 * 一次函数调用计一次，不按供应商内部检索次数扣减。预算边界见 docs/cn/04-invariants.md。
 */

import {
  WEB_SEARCH_FAILED_TEXT,
  WEB_SEARCH_MAX_SOURCES,
  WEB_SEARCH_REFUSED_TEXT,
  WEB_SEARCH_QUERY_MAX_CHARS,
  WEB_SEARCH_RESULT_MAX_CHARS,
  WEB_SEARCH_RESULT_NOTICE,
  WEB_SEARCH_SOURCE_TITLE_MAX_CHARS,
  WEB_SEARCH_SOURCES_HEADING,
} from "../../../consts/aiChat/tools";
import { WEB_SEARCH_EXECUTOR_INSTRUCTION } from "../../../consts/aiChat/prompts/search";
import { currentTimeSentence } from "../timeSentence";
import { WEB_SEARCH_TIME_LABEL } from "../../../consts/aiChat/prompts/researchTime";
import { logger } from "../../../infra/logger";
import { isPlainRecord } from "../../../libs/record";
import { sanitizeInline, truncateAtClauseBoundary, truncateInline } from "../../../libs/text";
import { toolError } from "../utils/toolResult";
import type {
  AiWebSearchFacade,
  AiWebSearchResult,
  AiWebSearchSource,
} from "../../../types/aiChat/provider";
import type { WebSearchToolExecutor, WebSearchToolOutcome } from "../../../types/aiChat/replies";

/** 解出模型给的检索问题；不是 `{ query: 非空字符串 }` 或超长时为 null。 */
function parseQuery(argumentsJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed) || typeof parsed.query !== "string") return null;
  const query: string = parsed.query.trim();
  if (query.length === 0 || query.length > WEB_SEARCH_QUERY_MAX_CHARS) return null;
  return query;
}

/**
 * 把结论与来源裁成交回模型的紧凑正文：首行提示语，其后是结论，最后是编号来源
 * （「n. 标题 地址」）。来源按地址去重、最多 WEB_SEARCH_MAX_SOURCES 条，来源列表超过总上限的
 * 一半时从末尾丢弃；结论在剩余额度内尽量收在子句边界上。
 */
export function formatWebSearchResult(text: string, sources: readonly AiWebSearchSource[]): string {
  const lines: string[] = [];
  const seen: Set<string> = new Set<string>();
  for (const source of sources) {
    if (lines.length === WEB_SEARCH_MAX_SOURCES) break;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    const title: string = truncateInline(sanitizeInline(source.title), WEB_SEARCH_SOURCE_TITLE_MAX_CHARS);
    lines.push(`${lines.length + 1}. ${title} ${source.url}`);
  }
  let footer: string = "";
  while (lines.length > 0) {
    footer = `\n${WEB_SEARCH_SOURCES_HEADING}\n${lines.join("\n")}`;
    if (footer.length <= WEB_SEARCH_RESULT_MAX_CHARS / 2) break;
    lines.pop();
    footer = "";
  }
  const head: string = `${WEB_SEARCH_RESULT_NOTICE}\n`;
  return head + truncateAtClauseBoundary(text, WEB_SEARCH_RESULT_MAX_CHARS - head.length - footer.length) + footer;
}

/**
 * 新建一轮回复的 web_search 执行器。
 * @param provider web_search 能力的门面（已经过配额闸门）。
 * @param maxCallsPerUse 本轮回复的函数调用上限，来自已校验的 web_search 配置快照。
 * @param signal 本轮回复的 generation 取消信号，交给检索请求一同取消。
 */
export function createWebSearchExecutor(
  provider: AiWebSearchFacade,
  maxCallsPerUse: number,
  signal: AbortSignal | undefined
): WebSearchToolExecutor {
  let calls: number = 0;

  function failed(reason: string, searchCalls: number): WebSearchToolOutcome {
    if (signal?.aborted !== true) {
      logger.error(`AI reply web_search tool returned "${WEB_SEARCH_FAILED_TEXT}" to the model: ${reason}.`);
    }
    return { result: toolError(WEB_SEARCH_FAILED_TEXT), searchCalls };
  }

  function refused(searchCalls: number): WebSearchToolOutcome {
    if (signal?.aborted !== true) {
      logger.error(`AI reply web_search tool returned "${WEB_SEARCH_REFUSED_TEXT}" to the model: the search model refused the request.`);
    }
    return { result: toolError(WEB_SEARCH_REFUSED_TEXT, { retryable: false }), searchCalls };
  }

  return async (argumentsJson: string): Promise<WebSearchToolOutcome> => {
    calls++;
    if (calls > maxCallsPerUse) {
      return failed(`the per-reply limit of ${maxCallsPerUse} web_search calls was exceeded`, 0);
    }
    const query: string | null = parseQuery(argumentsJson);
    if (query === null) return failed("the arguments were not a valid query", 0);
    const response: AiWebSearchResult = await provider.searchWeb({
      instruction: WEB_SEARCH_EXECUTOR_INSTRUCTION,
      query: `${query}\n${currentTimeSentence(WEB_SEARCH_TIME_LABEL)}`,
      signal,
    });
    if (!response.ok) {
      return response.refused === true
        ? refused(response.searchCalls)
        : failed("the search request failed", response.searchCalls);
    }
    if (response.searchCalls === 0) return failed("the endpoint answered without searching", 0);
    const text: string = response.text.trim();
    if (text.length === 0) return failed("the search returned no text", response.searchCalls);
    return {
      result: JSON.stringify({ result: formatWebSearchResult(text, response.sources) }),
      searchCalls: response.searchCalls,
    };
  };
}
