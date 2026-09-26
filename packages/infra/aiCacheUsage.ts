/**
 * 模型请求缓存用量的上报边界：各供应商客户端在拿到响应后调用 reportAiCacheUsage，
 * 本线程装了出口（cache/perThread/aiCacheUsage.ts）才发出。只读取响应的 usage 字段，
 * SDK 返回有效用量即计入，包括取消后迟到、正文为空或解码失败的响应；不改变业务结果。
 * 缺失、非法或无法投递时丢弃，并按能力/供应商/原因给出有界诊断。
 */

import { aiCacheUsageSink, aiUsageWarningKeys } from "../cache/perThread/aiCacheUsage";
import { logger } from "./logger";
import type { AiCacheCapability, AiCacheUsage, AiUsageUnavailableReason, AiUsageWarningKey } from "../types/aiCache";
import type { AgentProvider } from "../types/config";
import type { GenerateContentResponseUsageMetadata, Interactions } from "@google/genai";

/** reportAiCacheUsage 的入参；token 数按供应商原样传入，由本函数校验。 */
export interface AiCacheUsageReport {
  readonly capability: AiCacheCapability;
  readonly provider: AgentProvider;
  readonly model: string;
  readonly inputTokens: unknown;
  /** undefined 表示供应商没有给出缓存用量。 */
  readonly cachedInputTokens: unknown;
  readonly outputTokens: unknown;
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
}: AiCacheUsageReport): void {
  const sink: ((usage: AiCacheUsage) => void) | null = aiCacheUsageSink.current;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
    warnAiUsageUnavailable(capability, provider,
      inputTokens === undefined || outputTokens === undefined ? "missing" : "invalid");
    return;
  }
  let cached: number | null = null;
  if (cachedInputTokens !== undefined) {
    if (!isTokenCount(cachedInputTokens) || cachedInputTokens > inputTokens) {
      warnAiUsageUnavailable(capability, provider, "invalid");
      return;
    }
    cached = cachedInputTokens;
  }
  if (sink === null) {
    warnAiUsageUnavailable(capability, provider, "sink");
    return;
  }
  try {
    sink({
      timestamp: Date.now(),
      capability,
      provider,
      model,
      inputTokens,
      cachedInputTokens: cached,
      outputTokens,
    });
  } catch (error: unknown) {
    // Worker 出口拒收时只记录固定原因，不回显可能携带响应内容的异常。
    void error;
    warnAiUsageUnavailable(capability, provider, "transport");
  }
}

/** reportGeminiUsage 的入参：generateContent 响应的 usageMetadata 原样传入。 */
export interface GeminiUsageReport {
  readonly capability: AiCacheCapability;
  readonly model: string;
  readonly usage: GenerateContentResponseUsageMetadata | undefined;
}

/**
 * 上报一次 Gemini generateContent 的用量。隐式缓存没有命中时响应不带
 * cachedContentTokenCount，此时按 0 计；输出计入正文与思考两部分。
 */
export function reportGeminiUsage({ capability, model, usage }: GeminiUsageReport): void {
  if (usage === undefined) {
    warnAiUsageUnavailable(capability, "google", "missing");
    return;
  }
  if (usage === null || typeof usage !== "object" || Array.isArray(usage) || usage.cachedContentTokenCount === null) {
    warnAiUsageUnavailable(capability, "google", "invalid");
    return;
  }
  reportAiCacheUsage({
    capability,
    provider: "google",
    model,
    inputTokens: usage.promptTokenCount,
    cachedInputTokens: usage.cachedContentTokenCount ?? 0,
    outputTokens: geminiOutputTokens(usage.candidatesTokenCount, usage.thoughtsTokenCount),
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
