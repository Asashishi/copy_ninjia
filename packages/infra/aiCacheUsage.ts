/**
 * 模型请求用量的上报边界：各供应商客户端在拿到响应后调用 reportAiCacheUsage（token 口径）、
 * reportGeminiUsage / reportGeminiInteractionUsage（Gemini 响应适配）、reportAnthropicUsage（Anthropic
 * 响应适配）或 reportXAiUsage（xAI 响应适配，无 token 时经 reportAiCostUsage 按费用口径计入）。
 * 检索次数并入同一响应的 token 记录，没有有效 token 时经 reportAiSearchUsage 单独记录。
 * 本线程装了出口（cache/perThread/aiCacheUsage.ts）才发出。SDK 返回有效用量即计入，包括取消后迟到、正文为空或
 * 解码失败的响应；不改变业务结果。缺失、非法或无法投递时丢弃，并按能力/供应商/原因
 * 给出有界诊断。
 */

import { aiCacheUsageSink, aiUsageWarningKeys } from "../cache/perThread/aiCacheUsage";
import { logger } from "./logger";
import { isPlainRecord } from "../libs/record";
import type { AiCacheCapability, AiCacheUsage, AiUsageUnavailableReason, AiUsageWarningKey } from "../types/aiCache";
import type { AgentProvider } from "../types/config";
import type { GenerateContentResponseUsageMetadata, Interactions } from "@google/genai";
import type Anthropic from "@anthropic-ai/sdk";

/** reportAiCacheUsage 的入参；token 数按供应商原样传入，由本函数校验。 */
export interface AiCacheUsageReport {
  readonly capability: AiCacheCapability;
  readonly provider: AgentProvider;
  readonly model: string;
  readonly inputTokens: unknown;
  /** undefined 表示供应商没有给出缓存用量。 */
  readonly cachedInputTokens: unknown;
  readonly outputTokens: unknown;
  /** 同一响应的实际检索次数；缺省表示没有检索。 */
  readonly searchCalls?: number;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 正文与思考分别校验后相加；两者都缺失保持未知，非法分量交由统一出口拒绝。 */
function geminiOutputTokens(output: unknown, thoughts: unknown): number | undefined {
  if (output === undefined && thoughts === undefined) return undefined;
  if (output !== undefined && !isTokenCount(output)) return Number.NaN;
  if (thoughts !== undefined && !isTokenCount(thoughts)) return Number.NaN;
  return (output ?? 0) + (thoughts ?? 0);
}

/** 安装或卸下本线程的上报出口；Worker 启动时安装、停止时传 null。 */
export function installAiCacheUsageSink(sink: ((usage: AiCacheUsage) => void) | null): void {
  aiCacheUsageSink.current = sink;
  aiUsageWarningKeys.clear();
}

/** 每个出口生命周期按固定维度诊断一次，不输出模型名、请求或响应内容。 */
export function warnAiUsageUnavailable(
  capability: AiCacheCapability,
  provider: AgentProvider,
  reason: AiUsageUnavailableReason
): void {
  const key: AiUsageWarningKey = `${capability}/${provider}/${reason}`;
  if (aiUsageWarningKeys.has(key)) return;
  aiUsageWarningKeys.add(key);
  logger.warn(`AI token usage unavailable: capability=${capability}, provider=${provider}, reason=${reason}.`);
}

/** 校验并上报一次请求的用量；诊断和投递失败均不得改变模型请求的业务结果。 */
export function reportAiCacheUsage({
  capability,
  provider,
  model,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  searchCalls = 0,
}: AiCacheUsageReport): void {
  if (!isTokenCount(searchCalls)) warnAiUsageUnavailable(capability, provider, "invalid");
  const searches: number | undefined = isTokenCount(searchCalls) && searchCalls > 0 ? searchCalls : undefined;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
    warnAiUsageUnavailable(capability, provider,
      inputTokens === undefined || outputTokens === undefined ? "missing" : "invalid");
    if (searches !== undefined) reportAiSearchUsage({ capability, provider, model, searchCalls: searches });
    return;
  }
  let cached: number | null = null;
  if (cachedInputTokens !== undefined) {
    if (!isTokenCount(cachedInputTokens) || cachedInputTokens > inputTokens) {
      warnAiUsageUnavailable(capability, provider, "invalid");
      if (searches !== undefined) reportAiSearchUsage({ capability, provider, model, searchCalls: searches });
      return;
    }
    cached = cachedInputTokens;
  }
  deliverAiUsage({
    kind: "tokens",
    timestamp: Date.now(),
    capability,
    provider,
    model,
    inputTokens,
    cachedInputTokens: cached,
    outputTokens,
    searchCalls: searches,
  });
}

/** 把一条已校验的计量交给本线程出口；出口缺失或拒收时只给出固定原因的诊断。 */
function deliverAiUsage(usage: AiCacheUsage): void {
  const sink: ((usage: AiCacheUsage) => void) | null = aiCacheUsageSink.current;
  if (sink === null) {
    warnAiUsageUnavailable(usage.capability, usage.provider, "sink");
    return;
  }
  try {
    sink(usage);
  } catch (error: unknown) {
    // Worker 出口拒收时只记录固定原因，不回显可能携带响应内容的异常。
    void error;
    warnAiUsageUnavailable(usage.capability, usage.provider, "transport");
  }
}

/** reportAiCostUsage 的入参；费用按供应商原样传入，由本函数校验。 */
export interface AiCostUsageReport {
  readonly capability: AiCacheCapability;
  readonly provider: AgentProvider;
  readonly model: string;
  /** 本次请求的费用（xAI `cost_in_usd_ticks`，单位 tick）。 */
  readonly costInUsdTicks: unknown;
}

/** 校验并上报一次只给出费用的请求；诊断和投递失败均不得改变模型请求的业务结果。 */
export function reportAiCostUsage({ capability, provider, model, costInUsdTicks }: AiCostUsageReport): void {
  if (!isTokenCount(costInUsdTicks)) {
    warnAiUsageUnavailable(capability, provider, costInUsdTicks === undefined ? "missing" : "invalid");
    return;
  }
  deliverAiUsage({
    kind: "cost",
    timestamp: Date.now(),
    capability,
    provider,
    model,
    costInUsdTicks,
  });
}

/** reportAiSearchUsage 的入参；检索次数由调用方按响应计好。 */
export interface AiSearchUsageReport {
  readonly capability: AiCacheCapability;
  readonly provider: AgentProvider;
  readonly model: string;
  /** 这次请求里供应商实际执行的联网检索次数。 */
  readonly searchCalls: number;
}

/** 无有效 token 时单独上报检索次数；非法值诊断后丢弃，0 次不记，投递失败不改变业务结果。 */
export function reportAiSearchUsage({ capability, provider, model, searchCalls }: AiSearchUsageReport): void {
  if (!isTokenCount(searchCalls)) {
    warnAiUsageUnavailable(capability, provider, "invalid");
    return;
  }
  if (searchCalls === 0) return;
  deliverAiUsage({
    kind: "search",
    timestamp: Date.now(),
    capability,
    provider,
    model,
    searchCalls,
  });
}

/** reportXAiUsage 的入参：xAI 响应的 usage 对象原样传入。 */
export interface XAiUsageReport {
  readonly capability: AiCacheCapability;
  readonly model: string;
  readonly usage: unknown;
}

/**
 * 上报一次 xAI 请求的用量（经 OpenAI 兼容协议，供应商记为 openai）。xAI 的
 * input_tokens / output_tokens 可为空或缺席：任一项给出时走 token 口径（缓存命中取
 * input_tokens_details.cached_tokens），两项须齐全，只给一项按 missing 诊断且不改记费用；
 * 两项都没有时改按 usage.cost_in_usd_ticks 计入费用。
 */
export function reportXAiUsage({ capability, model, usage }: XAiUsageReport): void {
  if (usage !== undefined && !isPlainRecord(usage)) {
    warnAiUsageUnavailable(capability, "openai", "invalid");
    return;
  }
  const inputTokens: unknown = usage?.input_tokens ?? undefined;
  const outputTokens: unknown = usage?.output_tokens ?? undefined;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    const details: unknown = usage?.input_tokens_details;
    reportAiCacheUsage({
      capability,
      provider: "openai",
      model,
      inputTokens,
      cachedInputTokens: isPlainRecord(details) ? details.cached_tokens : undefined,
      outputTokens,
    });
    return;
  }
  reportAiCostUsage({ capability, provider: "openai", model, costInUsdTicks: usage?.cost_in_usd_ticks });
}

/** reportAnthropicUsage 的入参：Messages 响应的 usage 原样传入。 */
export interface AnthropicUsageReport {
  readonly capability: AiCacheCapability;
  readonly model: string;
  readonly usage: Anthropic.Usage | undefined;
  readonly searchCalls?: number;
}

/**
 * 上报一次 Anthropic Messages 的用量。`input_tokens` 不含缓存部分，而统一口径要求输入是总量、
 * 命中不超过输入，因此输入记 `input + cache_creation + cache_read`，命中记 `cache_read`
 * （两项缓存字段为 null 时按 0 与「未给出」处理）。
 */
export function reportAnthropicUsage({ capability, model, usage, searchCalls = 0 }: AnthropicUsageReport): void {
  if (usage !== undefined && (usage === null || typeof usage !== "object" || Array.isArray(usage))) {
    warnAiUsageUnavailable(capability, "anthropic", "invalid");
    reportAiSearchUsage({ capability, provider: "anthropic", model, searchCalls });
    return;
  }
  const input: number | undefined = usage?.input_tokens;
  const creation: number = usage?.cache_creation_input_tokens ?? 0;
  const read: number | null | undefined = usage?.cache_read_input_tokens;
  if ((input !== undefined && !isTokenCount(input)) || !isTokenCount(creation) ||
    (read !== undefined && read !== null && !isTokenCount(read))) {
    warnAiUsageUnavailable(capability, "anthropic", "invalid");
    reportAiSearchUsage({ capability, provider: "anthropic", model, searchCalls });
    return;
  }
  reportAiCacheUsage({
    capability,
    provider: "anthropic",
    model,
    inputTokens: typeof input === "number" ? input + creation + (read ?? 0) : input,
    cachedInputTokens: read ?? undefined,
    outputTokens: usage?.output_tokens,
    searchCalls,
  });
}

/** reportGeminiUsage 的入参：generateContent 响应的 usageMetadata 原样传入。 */
export interface GeminiUsageReport {
  readonly capability: AiCacheCapability;
  readonly model: string;
  readonly usage: GenerateContentResponseUsageMetadata | undefined;
  readonly searchCalls?: number;
}

/**
 * 上报一次 Gemini generateContent 的用量。隐式缓存没有命中时响应不带
 * cachedContentTokenCount，此时按 0 计；输出计入正文与思考两部分。
 */
export function reportGeminiUsage({ capability, model, usage, searchCalls = 0 }: GeminiUsageReport): void {
  if (usage === undefined) {
    warnAiUsageUnavailable(capability, "google", "missing");
    reportAiSearchUsage({ capability, provider: "google", model, searchCalls });
    return;
  }
  if (usage === null || typeof usage !== "object" || Array.isArray(usage) || usage.cachedContentTokenCount === null) {
    warnAiUsageUnavailable(capability, "google", "invalid");
    reportAiSearchUsage({ capability, provider: "google", model, searchCalls });
    return;
  }
  reportAiCacheUsage({
    capability,
    provider: "google",
    model,
    inputTokens: usage.promptTokenCount,
    cachedInputTokens: usage.cachedContentTokenCount ?? 0,
    outputTokens: geminiOutputTokens(usage.candidatesTokenCount, usage.thoughtsTokenCount),
    searchCalls,
  });
}

/** Gemini Interactions 响应的总用量；与 generateContent 的字段及思考 token 口径分别适配。 */
export interface GeminiInteractionUsageReport {
  readonly capability: AiCacheCapability;
  readonly model: string;
  readonly usage: Interactions.Usage | undefined;
}

/** Interactions 输出合计包含响应与独立的 thought token，缓存缺省表示未提供缓存计量。 */
export function reportGeminiInteractionUsage({ capability, model, usage }: GeminiInteractionUsageReport): void {
  if (usage !== undefined && (usage === null || typeof usage !== "object" || Array.isArray(usage))) {
    warnAiUsageUnavailable(capability, "google", "invalid");
    return;
  }
  reportAiCacheUsage({
    capability,
    provider: "google",
    model,
    inputTokens: usage?.total_input_tokens,
    cachedInputTokens: usage?.total_cached_tokens,
    outputTokens: geminiOutputTokens(usage?.total_output_tokens, usage?.total_thought_tokens),
  });
}
