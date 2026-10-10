/**
 * AI 缓存使用统计的共享类型（解码与汇总见 packages/workers/diskIO/aiCacheDocument.ts，
 * 落盘见 packages/workers/diskIO/aiCacheFile.ts，
 * 上报见 packages/infra/aiCacheUsage.ts）。
 */

import type { AgentCapability, AgentProvider } from "./config";

/** 统计口径下的调用方：agent.json 的各项能力，外加 ad_detect 段。 */
export type AiCacheCapability = AgentCapability | "ad_detect";

/** 响应用量未写入统计的原因；duration 表示供应商按时长计量而非 token。 */
export type AiUsageUnavailableReason = "missing" | "invalid" | "sink" | "duration" | "transport";

/** 有界诊断去重键；只由固定能力、供应商和失败原因组成，不含模型名或响应数据。 */
export type AiUsageWarningKey = `${AiCacheCapability}/${AgentProvider}/${AiUsageUnavailableReason}`;

/** 一次模型请求计量的公共部分；读取响应的用量与检索元数据，不含任何会话内容。 */
interface AiUsageBase {
  /** 收到响应的时刻（epoch 毫秒），决定这条记录归入配置时区的哪一天。 */
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
  /** 写入缓存的输入 token，属于 inputTokens、与 cachedInputTokens 不重叠；供应商没有给出缓存写入用量时缺省。 */
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens: number;
  /** 同一次请求执行的检索次数；无检索时缺省，计入 requests 一次。 */
  readonly searchCalls?: number;
}

/**
 * 供应商不给 token 数、只给本次请求费用时的计量（xAI 生图的 usage.cost_in_usd_ticks）。
 * 单位沿用 xAI 的 ticks。
 */
export interface AiCostUsage extends AiUsageBase {
  readonly kind: "cost";
  readonly costInUsdTicks: number;
}

/**
 * 一次请求里供应商实际执行的联网检索次数（web_search 执行器，或 text 回复挂的内建检索）。
 * 只在同一次请求没有有效 token 用量时单独记录，不算一次请求；次数为 0 时不记。
 */
export interface AiSearchUsage extends AiUsageBase {
  readonly kind: "search";
  readonly searchCalls: number;
}

/** 一次请求按 token 或费用计量；检索次数并入 token 记录，无有效 token 时单独记录。 */
export type AiCacheUsage = AiTokenUsage | AiCostUsage | AiSearchUsage;

/** 一组请求的用量合计；requests 同时计入 token 请求与费用请求，不计检索次数记录。 */
export interface AiCacheTotals {
  readonly requests: number;
  readonly inputTokens: number;
  /** 给出了缓存用量的那些请求的输入 token 合计；命中率的分母。 */
  readonly reportedInputTokens: number;
  readonly cachedInputTokens: number;
  /**
   * 给出了缓存写入用量的那些请求的写入 token 合计；这组没有这类请求时为 undefined，落盘时省略该键，
   * 文件里缺省即为从没有请求给出过缓存写入用量。
   */
  readonly cacheWriteInputTokens: number | undefined;
  readonly outputTokens: number;
  /** cachedInputTokens / reportedInputTokens，保留 AI_CACHE_HIT_RATE_DIGITS 位小数；分母为 0 时为 null。 */
  readonly cacheHitRate: number | null;
  /**
   * 按费用计量的请求的费用合计（ticks，口径同 AiCostUsage）；这组没有费用请求时为
   * undefined，落盘时省略该键，文件里缺省即为从没有过费用请求。
   */
  readonly costInUsdTicks: number | undefined;
  /**
   * token 记录与独立检索记录的次数合计；这组没有检索时为 undefined，落盘时省略该键，文件里缺省即为
   * 从没有过检索。
   */
  readonly searchCalls: number | undefined;
}

/** 一个配置时区的自然日的汇总；总计为 byModel 各组之和，键为 `<capability>/<provider>/<model>`。 */
export interface AiCacheSummary extends AiCacheTotals {
  readonly day: string;
  readonly byModel: Readonly<Record<string, AiCacheTotals>>;
}

/** 文件里一条按 token 计量的用量；时间在键上。 */
export type AiCacheTokenRow = Omit<AiTokenUsage, "kind" | "timestamp">;

/** 文件里一条按费用计量的用量（供应商只给出费用时）；时间在键上。 */
export type AiCacheCostRow = Omit<AiCostUsage, "kind" | "timestamp">;

/** 文件里一条无有效 token 的联网检索次数记录；时间在键上。 */
export type AiCacheSearchRow = Omit<AiSearchUsage, "kind" | "timestamp">;

/** 文件里的一条用量：token（可带检索次数）、费用或独立检索次数，以字段集合区分。 */
export type AiCacheRow = AiCacheTokenRow | AiCacheCostRow | AiCacheSearchRow;

/** 解码后的统计文件；rows 保留文件中的顺序。 */
export interface AiCacheDocument {
  readonly summary: AiCacheSummary | null;
  readonly rows: ReadonlyMap<string, AiCacheRow>;
}
