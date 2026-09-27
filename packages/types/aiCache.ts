/**
 * AI 缓存使用统计的共享类型（落盘见 packages/workers/diskIO/aiCacheFile.ts，
 * 上报见 packages/infra/aiCacheUsage.ts）。
 */

import type { AgentCapability, AgentProvider } from "./config";

/** 统计口径下的调用方：agent.json 的各项能力，外加 ad_detect 段。 */
export type AiCacheCapability = AgentCapability | "ad_detect";

/** 响应用量未写入统计的原因；duration 表示供应商按时长计量而非 token。 */
export type AiUsageUnavailableReason = "missing" | "invalid" | "sink" | "duration" | "transport";

/** 有界诊断去重键；只由固定能力、供应商和失败原因组成，不含模型名或响应数据。 */
export type AiUsageWarningKey = `${AiCacheCapability}/${AgentProvider}/${AiUsageUnavailableReason}`;

/** 一次模型请求计量的公共部分；只取响应里的 usage 字段，不含任何会话内容。 */
interface AiUsageBase {
  /** 收到响应的时刻（epoch 毫秒），决定这条记录归入东京哪一天。 */
  readonly timestamp: number;
  readonly capability: AiCacheCapability;
  readonly provider: AgentProvider;
  readonly model: string;
}

/** 供应商给出 token 数时的计量；此时只记 token，不记费用。 */
export interface AiTokenUsage extends AiUsageBase {
  readonly kind: "tokens";
  readonly inputTokens: number;
  /** 命中缓存的输入 token；供应商没有给出缓存用量时为 null。 */
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number;
}

/**
 * 供应商不给 token 数、只给本次请求费用时的计量（xAI 生图的 usage.cost_in_usd_ticks）。
 * 单位沿用 xAI：1 美元 = 10,000,000,000 ticks。
 */
export interface AiCostUsage extends AiUsageBase {
  readonly kind: "cost";
  readonly costInUsdTicks: number;
}

/** 一次模型请求的计量：token 与费用二选一，按响应实际给出的内容决定。 */
export type AiCacheUsage = AiTokenUsage | AiCostUsage;

/** 一组请求的用量合计；requests 同时计入 token 请求与费用请求。 */
export interface AiCacheTotals {
  readonly requests: number;
  readonly inputTokens: number;
  /** 给出了缓存用量的那些请求的输入 token 合计；命中率的分母。 */
  readonly reportedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** cachedInputTokens / reportedInputTokens，保留 4 位小数；分母为 0 时为 null。 */
  readonly cacheHitRate: number | null;
  /**
   * 按费用计量的请求的费用合计（ticks，口径同 AiCostUsage）；这组没有费用请求时为
   * undefined，落盘时省略该键，文件里缺省即为从没有过费用请求。
   */
  readonly costInUsdTicks: number | undefined;
}

/** 一个东京自然日的汇总；byModel 的键为 `<capability>/<provider>/<model>`。 */
export interface AiCacheSummary extends AiCacheTotals {
  readonly day: string;
  readonly byModel: Readonly<Record<string, AiCacheTotals>>;
}
