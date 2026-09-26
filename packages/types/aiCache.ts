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

/** 一次模型请求的 token 用量；只取响应里的 usage 字段，不含任何会话内容。 */
export interface AiCacheUsage {
  /** 收到响应的时刻（epoch 毫秒），决定这条记录归入东京哪一天。 */
  readonly timestamp: number;
  readonly capability: AiCacheCapability;
  readonly provider: AgentProvider;
  readonly model: string;
  readonly inputTokens: number;
  /** 命中缓存的输入 token；供应商没有给出缓存用量时为 null。 */
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number;
}

/** 一组请求的用量合计。 */
export interface AiCacheTotals {
  readonly requests: number;
  readonly inputTokens: number;
  /** 给出了缓存用量的那些请求的输入 token 合计；命中率的分母。 */
  readonly reportedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** cachedInputTokens / reportedInputTokens，保留 4 位小数；分母为 0 时为 null。 */
  readonly cacheHitRate: number | null;
}

/** 一个东京自然日的汇总；byModel 的键为 `<capability>/<provider>/<model>`。 */
export interface AiCacheSummary extends AiCacheTotals {
  readonly day: string;
  readonly byModel: Readonly<Record<string, AiCacheTotals>>;
}
