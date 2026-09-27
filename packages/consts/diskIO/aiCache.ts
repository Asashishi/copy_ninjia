/** AI 缓存使用统计（packages/workers/diskIO/aiCacheFile.ts）的格式常量。 */

import { AGENT_CAPABILITY_NAMES } from "../agent";

/** 统计文件里汇总条目的键，写在对象首位。所属模块：workers/diskIO/aiCacheFile.ts。 */
export const AI_CACHE_SUMMARY_KEY: string = "summary";

/**
 * 逐条用量记录的键：东京时间「YYYY-MM-DD HH:mm:ss.SSS」加 UUID，第 1 组捕获东京日期。
 * 所属模块：workers/diskIO/aiCacheFile.ts。
 */
export const AI_CACHE_ROW_KEY_PATTERN: RegExp =
  /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\.\d{3}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 命中率保留的小数位数。所属模块：workers/diskIO/aiCacheFile.ts。 */
export const AI_CACHE_HIT_RATE_DIGITS: number = 4;

/**
 * 统计口径下全部调用方，用于解码校验；直接取 agent.json 的能力名单（含 ad_detect），
 * 新增能力无需改这里。所属模块：workers/diskIO/aiCacheFile.ts。
 */
export const AI_CACHE_CAPABILITIES: ReadonlySet<string> = new Set(AGENT_CAPABILITY_NAMES);

/**
 * 按 token 计量的逐条记录的全部字段，缺一或多一都拒绝接管；与 AI_CACHE_COST_ROW_FIELDS
 * 二选一。所属模块：workers/diskIO/aiCacheFile.ts。
 */
export const AI_CACHE_ROW_FIELDS: readonly string[] = [
  "capability", "provider", "model", "inputTokens", "cachedInputTokens", "outputTokens",
];

/**
 * 按费用计量的逐条记录的全部字段（供应商只给出 cost_in_usd_ticks 时）；与
 * AI_CACHE_ROW_FIELDS 二选一。所属模块：workers/diskIO/aiCacheFile.ts。
 */
export const AI_CACHE_COST_ROW_FIELDS: readonly string[] = [
  "capability", "provider", "model", "costInUsdTicks",
];

/**
 * 合计（汇总本身与 byModel 每一组）的必填字段；另可带 AI_CACHE_TOTALS_OPTIONAL_FIELDS。
 * 所属模块：workers/diskIO/aiCacheFile.ts。
 */
export const AI_CACHE_TOTALS_FIELDS: readonly string[] = [
  "requests", "inputTokens", "reportedInputTokens", "cachedInputTokens", "outputTokens", "cacheHitRate",
];

/**
 * 合计的可选字段：费用请求的费用合计，只在这组有费用请求时写出，缺省即从没有过费用请求。
 * 所属模块：workers/diskIO/aiCacheFile.ts。
 */
export const AI_CACHE_TOTALS_OPTIONAL_FIELDS: readonly string[] = ["costInUsdTicks"];

/** 汇总条目的必填字段：日期、合计必填字段与 byModel。所属模块：workers/diskIO/aiCacheFile.ts。 */
export const AI_CACHE_SUMMARY_FIELDS: readonly string[] = ["day", ...AI_CACHE_TOTALS_FIELDS, "byModel"];

/**
 * 汇总 byModel 的分组键 `<capability>/<provider>/<model>`：第 1 组捕获 capability、第 2 组
 * 捕获 provider；模型名可以含 `/`。所属模块：workers/diskIO/aiCacheFile.ts。
 */
export const AI_CACHE_GROUP_KEY_PATTERN: RegExp = /^([^/]+)\/(openai|google)\/(.+)$/;
