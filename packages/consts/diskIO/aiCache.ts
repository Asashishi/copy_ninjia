/** AI 缓存使用统计的格式常量。 */

import { AGENT_CAPABILITY_NAMES, AGENT_PROVIDERS } from "../agent";

/** 统计文件里汇总条目的键，写在对象首位。所属模块：workers/diskIO/aiCacheDocument.ts。 */
export const AI_CACHE_SUMMARY_KEY: string = "summary";

/**
 * 逐条用量记录的键：配置时区的时间「YYYY-MM-DD HH:mm:ss.SSS」加 UUID，第 1 组捕获配置时区的日期；
 * 时分秒限制在日内范围，日期由解码器核验公历有效性。
 * 所属模块：workers/diskIO/aiCacheDocument.ts。
 */
export const AI_CACHE_ROW_KEY_PATTERN: RegExp =
  /^(\d{4}-\d{2}-\d{2}) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 命中率保留的小数位数。所属模块：workers/diskIO/aiCacheDocument.ts。 */
export const AI_CACHE_HIT_RATE_DIGITS: number = 4;

/**
 * 统计口径下全部调用方，用于解码校验；直接取 agent.json 的能力名单（含 ad_detect），
 * 新增能力无需改这里。所属模块：workers/diskIO/aiCacheDocument.ts。
 */
export const AI_CACHE_CAPABILITIES: ReadonlySet<string> = new Set(AGENT_CAPABILITY_NAMES);

/**
 * 按 token 计量的逐条记录的必填字段，另可带 AI_CACHE_TOKEN_ROW_OPTIONAL_FIELDS。
 * 所属模块：workers/diskIO/aiCacheDocument.ts。
 */
export const AI_CACHE_ROW_FIELDS: readonly string[] = [
  "capability", "provider", "model", "inputTokens", "cachedInputTokens", "outputTokens",
];

/**
 * token 记录的可选字段：供应商给出的缓存写入 token 与同一次请求的实际检索次数。
 * 所属模块：workers/diskIO/aiCacheDocument.ts。
 */
export const AI_CACHE_TOKEN_ROW_OPTIONAL_FIELDS: readonly string[] = ["cacheWriteInputTokens", "searchCalls"];

/**
 * 按费用计量的逐条记录的全部字段（供应商只给出 cost_in_usd_ticks 时），不带 token 或检索字段。
 * 所属模块：workers/diskIO/aiCacheDocument.ts。
 */
export const AI_CACHE_COST_ROW_FIELDS: readonly string[] = [
  "capability", "provider", "model", "costInUsdTicks",
];

/**
 * 无有效 token 时单独记录检索次数的全部字段，不计入 requests。
 * 所属模块：workers/diskIO/aiCacheDocument.ts。
 */
export const AI_CACHE_SEARCH_ROW_FIELDS: readonly string[] = [
  "capability", "provider", "model", "searchCalls",
];

/**
 * 合计（汇总本身与 byModel 每一组）的必填字段；另可带 AI_CACHE_TOTALS_OPTIONAL_FIELDS。
 * 所属模块：workers/diskIO/aiCacheDocument.ts。
 */
export const AI_CACHE_TOTALS_FIELDS: readonly string[] = [
  "requests", "inputTokens", "reportedInputTokens", "cachedInputTokens", "outputTokens", "cacheHitRate",
];

/**
 * 合计的可选字段：缓存写入 token 合计、费用请求的费用合计与检索次数合计，各自只在这组有对应记录时
 * 写出，缺省即从没有过这类记录。所属模块：workers/diskIO/aiCacheDocument.ts。
 */
export const AI_CACHE_TOTALS_OPTIONAL_FIELDS: readonly string[] = ["cacheWriteInputTokens", "costInUsdTicks", "searchCalls"];

/** 汇总条目的必填字段：日期、合计必填字段与 byModel。所属模块：workers/diskIO/aiCacheDocument.ts。 */
export const AI_CACHE_SUMMARY_FIELDS: readonly string[] = ["day", ...AI_CACHE_TOTALS_FIELDS, "byModel"];

/**
 * 汇总 byModel 的分组键 `<capability>/<provider>/<model>`：第 1 组捕获 capability、第 2 组
 * 捕获 provider（AGENT_PROVIDERS 之一）；模型名可以含 `/`。所属模块：workers/diskIO/aiCacheDocument.ts。
 */
export const AI_CACHE_GROUP_KEY_PATTERN: RegExp = new RegExp(`^([^/]+)/(${AGENT_PROVIDERS.join("|")})/(.+)$`);
