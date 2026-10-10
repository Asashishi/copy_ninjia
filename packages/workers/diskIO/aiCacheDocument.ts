/** AI 用量文件的严格解码与汇总；字符串字段去掉首尾空白，空值与非法计数拒绝。运行时和停机脚本共用，不访问线程缓存。 */

import {
  AI_CACHE_CAPABILITIES,
  AI_CACHE_COST_ROW_FIELDS,
  AI_CACHE_GROUP_KEY_PATTERN,
  AI_CACHE_HIT_RATE_DIGITS,
  AI_CACHE_ROW_FIELDS,
  AI_CACHE_ROW_KEY_PATTERN,
  AI_CACHE_SEARCH_ROW_FIELDS,
  AI_CACHE_SUMMARY_FIELDS,
  AI_CACHE_SUMMARY_KEY,
  AI_CACHE_TOTALS_FIELDS,
  AI_CACHE_TOTALS_OPTIONAL_FIELDS,
  AI_CACHE_TOKEN_ROW_OPTIONAL_FIELDS,
} from "../../consts/diskIO/aiCache";
import { isAgentProvider } from "../../consts/agent";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { isCanonicalDateKey } from "../../libs/time";
import type { AiCacheCapability, AiCacheDocument, AiCacheRow, AiCacheSummary, AiCacheTotals } from "../../types/aiCache";
import { AppendOnlyFileFormatError } from "./appendOnlyDayFile";

/**
 * 可累加的合计；命中率在输出时才计算，cacheWriteInputTokens、costInUsdTicks 与 searchCalls 在计入第一条
 * 对应记录前为 undefined。
 */
interface MutableTotals {
  requests: number;
  inputTokens: number;
  reportedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number | undefined;
  outputTokens: number;
  costInUsdTicks: number | undefined;
  searchCalls: number | undefined;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalid(path: string, reason: string): never {
  throw new AppendOnlyFileFormatError(path, reason);
}

function decodeRow(path: string, index: number, value: unknown): AiCacheRow {
  if (!isPlainRecord(value)) return invalid(path, `contains an invalid usage record at entry[${index}]; expected a usage object.`);
  const capability: string = typeof value.capability === "string" ? value.capability.trim() : "";
  const provider: string = typeof value.provider === "string" ? value.provider.trim() : "";
  const model: string = typeof value.model === "string" ? value.model.trim() : "";
  if (
    !AI_CACHE_CAPABILITIES.has(capability) ||
    !isAgentProvider(provider) ||
    model.length === 0
  ) {
    return invalid(path, `contains an invalid usage record at entry[${index}]; expected a supported capability/provider and non-empty model.`);
  }
  if (hasExactKeys(value, AI_CACHE_SEARCH_ROW_FIELDS)) {
    if (!isTokenCount(value.searchCalls) || value.searchCalls === 0) {
      return invalid(path, `contains an invalid usage record at entry[${index}].searchCalls; expected a positive safe integer.`);
    }
    return {
      capability: capability as AiCacheCapability,
      provider,
      model,
      searchCalls: value.searchCalls,
    };
  }
  if (hasExactKeys(value, AI_CACHE_COST_ROW_FIELDS)) {
    if (!isTokenCount(value.costInUsdTicks)) return invalid(path, `contains an invalid usage record at entry[${index}].costInUsdTicks; expected a non-negative safe integer.`);
    return {
      capability: capability as AiCacheCapability,
      provider,
      model,
      costInUsdTicks: value.costInUsdTicks,
    };
  }
  if (
    !AI_CACHE_ROW_FIELDS.every((field: string): boolean => Object.hasOwn(value, field)) ||
    !hasOnlyKeys(value, [...AI_CACHE_ROW_FIELDS, ...AI_CACHE_TOKEN_ROW_OPTIONAL_FIELDS]) ||
    (Object.hasOwn(value, "searchCalls") && (!isTokenCount(value.searchCalls) || value.searchCalls === 0)) ||
    !isTokenCount(value.inputTokens) ||
    (value.cachedInputTokens !== null &&
      (!isTokenCount(value.cachedInputTokens) || value.cachedInputTokens > value.inputTokens)) ||
    (Object.hasOwn(value, "cacheWriteInputTokens") &&
      (!isTokenCount(value.cacheWriteInputTokens) ||
        value.cacheWriteInputTokens > value.inputTokens - (value.cachedInputTokens ?? 0))) ||
    !isTokenCount(value.outputTokens)
  ) {
    return invalid(path, `contains an invalid usage record at entry[${index}]; expected non-negative safe-integer token counts, cachedInputTokens null or at most inputTokens, optional cacheWriteInputTokens at most inputTokens minus cachedInputTokens, and optional positive searchCalls.`);
  }
  return {
    capability: capability as AiCacheCapability,
    provider,
    model,
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    cacheWriteInputTokens: value.cacheWriteInputTokens as number | undefined,
    outputTokens: value.outputTokens,
    searchCalls: value.searchCalls as number | undefined,
  };
}

/** 命中率：cached / reported，保留 AI_CACHE_HIT_RATE_DIGITS 位小数；分母为 0 时为 null。 */
function hitRate(cachedInputTokens: number, reportedInputTokens: number): number | null {
  if (reportedInputTokens === 0) return null;
  const scale: number = 10 ** AI_CACHE_HIT_RATE_DIGITS;
  return Math.round(cachedInputTokens / reportedInputTokens * scale) / scale;
}

/** 必填字段齐全，且除必填与 AI_CACHE_TOTALS_OPTIONAL_FIELDS 外没有别的字段。 */
function hasTotalsKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return false;
  }
  return hasOnlyKeys(value, [...required, ...AI_CACHE_TOTALS_OPTIONAL_FIELDS]);
}

/**
 * 解码一份合计；汇总本身比 byModel 分组多 day 与 byModel，由 field 选择必填字段集合。
 * cacheWriteInputTokens、costInUsdTicks 与 searchCalls 可缺省；命中数不得超过有缓存口径的输入数，后者不得
 * 超过总输入数，写入数不得超过总输入数减命中数，命中率必须等于按同一口径重算的值。
 */
function decodeTotals(path: string, value: unknown, field: string): AiCacheTotals {
  const keys: readonly string[] = field === AI_CACHE_SUMMARY_KEY ? AI_CACHE_SUMMARY_FIELDS : AI_CACHE_TOTALS_FIELDS;
  if (
    !isPlainRecord(value) ||
    !hasTotalsKeys(value, keys) ||
    (value.costInUsdTicks !== undefined && !isTokenCount(value.costInUsdTicks)) ||
    (value.searchCalls !== undefined && !isTokenCount(value.searchCalls)) ||
    !isTokenCount(value.requests) ||
    !isTokenCount(value.inputTokens) ||
    !isTokenCount(value.reportedInputTokens) ||
    !isTokenCount(value.cachedInputTokens) ||
    !isTokenCount(value.outputTokens) ||
    value.reportedInputTokens > value.inputTokens ||
    value.cachedInputTokens > value.reportedInputTokens ||
    (value.cacheWriteInputTokens !== undefined &&
      (!isTokenCount(value.cacheWriteInputTokens) ||
        value.cacheWriteInputTokens > value.inputTokens - value.cachedInputTokens)) ||
    value.cacheHitRate !== hitRate(value.cachedInputTokens, value.reportedInputTokens)
  ) {
    return invalid(path, `contains invalid totals at ${field}. Expected non-negative safe-integer counters, cachedInputTokens <= reportedInputTokens <= inputTokens, optional cacheWriteInputTokens <= inputTokens - cachedInputTokens, and the calculated cacheHitRate.`);
  }
  return {
    requests: value.requests,
    inputTokens: value.inputTokens,
    reportedInputTokens: value.reportedInputTokens,
    cachedInputTokens: value.cachedInputTokens,
    cacheWriteInputTokens: value.cacheWriteInputTokens,
    outputTokens: value.outputTokens,
    cacheHitRate: hitRate(value.cachedInputTokens, value.reportedInputTokens),
    costInUsdTicks: value.costInUsdTicks,
    searchCalls: value.searchCalls,
  };
}

function isGroupKey(group: string): boolean {
  const match: RegExpExecArray | null = AI_CACHE_GROUP_KEY_PATTERN.exec(group);
  return match !== null && AI_CACHE_CAPABILITIES.has(match[1]!) && match[3]!.trim().length > 0;
}

function decodeSummary(path: string, value: unknown): AiCacheSummary {
  if (!isPlainRecord(value)) return invalid(path, `contains an invalid ${AI_CACHE_SUMMARY_KEY}; expected a summary object.`);
  const day: string = typeof value.day === "string" ? value.day.trim() : "";
  if (!isCanonicalDateKey(day)) {
    return invalid(path, `contains an invalid ${AI_CACHE_SUMMARY_KEY}.day. Expected a valid YYYY-MM-DD calendar date.`);
  }
  if (!isPlainRecord(value.byModel)) return invalid(path, `contains an invalid ${AI_CACHE_SUMMARY_KEY}.byModel. Expected an object of model totals.`);
  const byModel: Record<string, AiCacheTotals> = Object.create(null) as Record<string, AiCacheTotals>;
  const grouped: MutableTotals = emptyTotals();
  let index: number = 0;
  for (const [group, totals] of Object.entries(value.byModel)) {
    if (!isGroupKey(group)) return invalid(path, `contains an invalid ${AI_CACHE_SUMMARY_KEY}.byModel key at entry[${index}]; expected <capability>/<provider>/<model> with a supported capability/provider and non-empty model.`);
    const decoded: AiCacheTotals = decodeTotals(path, totals, `${AI_CACHE_SUMMARY_KEY}.byModel[${index}]`);
    byModel[group] = decoded;
    addTotals(grouped, decoded);
    index++;
  }
  const overall: AiCacheTotals = decodeTotals(path, value, AI_CACHE_SUMMARY_KEY);
  const combined: AiCacheTotals = finishTotals(grouped);
  for (const field of [...AI_CACHE_TOTALS_FIELDS, ...AI_CACHE_TOTALS_OPTIONAL_FIELDS]) {
    if (value[field] !== combined[field as keyof AiCacheTotals]) {
      return invalid(path, `contains totals inconsistent with ${AI_CACHE_SUMMARY_KEY}.byModel at ${AI_CACHE_SUMMARY_KEY}.${field}.`);
    }
  }
  return {
    day,
    ...overall,
    byModel,
  };
}

/** 严格解码当前用量文件；不读写文件，不接触线程缓存。 */
export function decodeAiCacheDocument(path: string, parsed: unknown): AiCacheDocument {
  if (!isPlainRecord(parsed)) return invalid(path, "must contain a top-level JSON object.");
  let summary: AiCacheSummary | null = null;
  const rows: Map<string, AiCacheRow> = new Map();
  let index: number = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (key === AI_CACHE_SUMMARY_KEY) {
      if (index !== 0) invalid(path, `must put ${AI_CACHE_SUMMARY_KEY} first.`);
      summary = decodeSummary(path, value);
    } else if (AI_CACHE_ROW_KEY_PATTERN.test(key) && isCanonicalDateKey(key.slice(0, 10))) {
      rows.set(key, decodeRow(path, index, value));
    } else {
      invalid(path, `entry[${index}] key must be ${AI_CACHE_SUMMARY_KEY} or a valid local YYYY-MM-DD HH:mm:ss.SSS timestamp followed by a UUID.`);
    }
    index++;
  }
  return { summary, rows };
}

function emptyTotals(): MutableTotals {
  return {
    requests: 0,
    inputTokens: 0,
    reportedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: undefined,
    outputTokens: 0,
    costInUsdTicks: undefined,
    searchCalls: undefined,
  };
}

/** 计入一条记录；token 记录含检索时仍算一次请求，独立检索记录只累加次数。 */
function addRow(totals: MutableTotals, row: AiCacheRow): void {
  if ("searchCalls" in row && row.searchCalls !== undefined) totals.searchCalls = (totals.searchCalls ?? 0) + row.searchCalls;
  if (!("inputTokens" in row) && !("costInUsdTicks" in row)) return;
  totals.requests += 1;
  if ("costInUsdTicks" in row) {
    totals.costInUsdTicks = (totals.costInUsdTicks ?? 0) + row.costInUsdTicks;
    return;
  }
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
  if (row.cacheWriteInputTokens !== undefined) {
    totals.cacheWriteInputTokens = (totals.cacheWriteInputTokens ?? 0) + row.cacheWriteInputTokens;
  }
  if (row.cachedInputTokens === null) return;
  totals.reportedInputTokens += row.inputTokens;
  totals.cachedInputTokens += row.cachedInputTokens;
}

function addTotals(totals: MutableTotals, other: AiCacheTotals): void {
  totals.requests += other.requests;
  totals.inputTokens += other.inputTokens;
  totals.reportedInputTokens += other.reportedInputTokens;
  totals.cachedInputTokens += other.cachedInputTokens;
  totals.outputTokens += other.outputTokens;
  if (other.cacheWriteInputTokens !== undefined) {
    totals.cacheWriteInputTokens = (totals.cacheWriteInputTokens ?? 0) + other.cacheWriteInputTokens;
  }
  if (other.costInUsdTicks !== undefined) {
    totals.costInUsdTicks = (totals.costInUsdTicks ?? 0) + other.costInUsdTicks;
  }
  if (other.searchCalls !== undefined) {
    totals.searchCalls = (totals.searchCalls ?? 0) + other.searchCalls;
  }
}

function finishTotals(totals: MutableTotals): AiCacheTotals {
  return {
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    reportedInputTokens: totals.reportedInputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheWriteInputTokens: totals.cacheWriteInputTokens,
    outputTokens: totals.outputTokens,
    cacheHitRate: hitRate(totals.cachedInputTokens, totals.reportedInputTokens),
    costInUsdTicks: totals.costInUsdTicks,
    searchCalls: totals.searchCalls,
  };
}

/**
 * 把 day 当天的记录汇总成一份 summary；previous 是同一天已有的汇总时相加。
 * byModel 按键排序，键为 `<capability>/<provider>/<model>`；总计由分组相加，命中率统一重算。
 */
export function buildAiCacheSummary(
  day: string,
  rows: readonly AiCacheRow[],
  previous: AiCacheSummary | null
): AiCacheSummary {
  const overall: MutableTotals = emptyTotals();
  const groups: Map<string, MutableTotals> = new Map();
  if (previous !== null) {
    for (const [group, totals] of Object.entries(previous.byModel)) {
      const merged: MutableTotals = emptyTotals();
      addTotals(merged, totals);
      groups.set(group, merged);
    }
  }
  for (const row of rows) {
    const group: string = `${row.capability}/${row.provider}/${row.model}`;
    let totals: MutableTotals | undefined = groups.get(group);
    if (totals === undefined) {
      totals = emptyTotals();
      groups.set(group, totals);
    }
    addRow(totals, row);
  }
  const byModel: Record<string, AiCacheTotals> = {};
  for (const group of [...groups.keys()].sort()) {
    const totals: AiCacheTotals = finishTotals(groups.get(group)!);
    byModel[group] = totals;
    addTotals(overall, totals);
  }
  return { day, ...finishTotals(overall), byModel };
}
