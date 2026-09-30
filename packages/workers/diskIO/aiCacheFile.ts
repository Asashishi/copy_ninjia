/**
 * AI 缓存使用统计落盘：memory/ai-daily-usage/usage.json 一份文件，内容是一个顶层 JSON 对象。
 *
 * - `summary`（写在首位）：最近一个已结束东京日的汇总，见 types/aiCache.ts 的 AiCacheSummary；
 *   有过费用请求的合计另带 costInUsdTicks，没有时省略该键。
 * - 其余键：尚未汇总的逐条用量，键为「东京时间 YYYY-MM-DD HH:mm:ss.SSS_uuid」，值为
 *   capability、provider、model 加上三项 token 数或 costInUsdTicks 二者之一（供应商给出
 *   token 时只记 token，只给费用时记费用）。
 *
 * 逐条记录经诊断通道到达后先进内存缓冲（cache/workers/diskIO/aiCache.ts），达到
 * FLUSH_MAX_ENTRIES 或等满 FLUSH_INTERVAL_MS 后按 appendOnlyDayFile.ts 的机制追加到文件末尾，
 * 统一 flush 时也会刷出。每日东京 0 点的维护 cron（maintenanceCron.ts）与启动维护调用
 * summarizeAiCache：先刷缓冲，再把今天之前的记录汇总成最近那一天的 summary（与同日已有汇总
 * 相加），删掉这些记录后整份原子重写；更早日期的记录与旧汇总不保留。
 *
 * 统计是旁路数据：写盘失败只丢这一批并 console.error，不计入统一 flush 回执的失败领域，
 * 也不升级为业务失败。文件存在但不是当前格式时，与日志一样尝试裁掉撕裂的尾部；仍不合法
 * （未知键或缺字段、summary 不在首位、合计之间不自洽）则拒绝接管并保留原字节。
 */

import { mkdirSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import {
  aiCacheBuffer,
  aiCacheFileState,
  aiCacheReopenState,
  resetAiCacheState,
} from "../../cache/workers/diskIO/aiCache";
import {
  AI_CACHE_CAPABILITIES,
  AI_CACHE_COST_ROW_FIELDS,
  AI_CACHE_GROUP_KEY_PATTERN,
  AI_CACHE_HIT_RATE_DIGITS,
  AI_CACHE_ROW_FIELDS,
  AI_CACHE_ROW_KEY_PATTERN,
  AI_CACHE_SUMMARY_FIELDS,
  AI_CACHE_SUMMARY_KEY,
  AI_CACHE_TOTALS_FIELDS,
  AI_CACHE_TOTALS_OPTIONAL_FIELDS,
} from "../../consts/diskIO/aiCache";
import {
  DAY_FILE_JSON_INDENT,
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_ENTRIES,
  LOG_REOPEN_RETRY_MS,
} from "../../consts/diskIO/appendOnly";
import { AI_CACHE_FILE_PATH, AI_CACHE_MEMORY_DIR } from "../../consts/paths";
import { atomicWriteTextSync, removeOrphanedTempFiles } from "../../libs/atomicFile";
import { inspectOptionalDirectory } from "../../libs/fileAccess";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { formatTokyoLogTimestamp, getTokyoDateKey, isCanonicalDateKey } from "../../libs/time";
import type { AiCacheCapability, AiCacheSummary, AiCacheTotals } from "../../types/aiCache";
import type { AgentProvider } from "../../types/config";
import type { AiCacheUsageDiskMessage } from "../../types/diskIO/messages";
import type { AppendOnlyFileState } from "../../types/diskIO/storage";
import {
  AppendOnlyFileFormatError,
  appendToAppendOnlyFile,
  inspectRepairableAppendOnlyFile,
  serializeDayFileEntry,
} from "./appendOnlyDayFile";
import type { RepairableAppendOnlyInspection } from "./appendOnlyDayFile";
import { armDiskIOFlushTimer, cancelDiskIOFlushTimer } from "./timedFlush";

/** 文件里一条按 token 计量的用量；时间在键上。 */
interface AiCacheTokenRow {
  readonly capability: AiCacheCapability;
  readonly provider: AgentProvider;
  readonly model: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number;
}

/** 文件里一条按费用计量的用量（供应商只给出费用时）；时间在键上。 */
interface AiCacheCostRow {
  readonly capability: AiCacheCapability;
  readonly provider: AgentProvider;
  readonly model: string;
  readonly costInUsdTicks: number;
}

/** 文件里的一条逐条用量：token 与费用二选一，以字段集合区分。 */
type AiCacheRow = AiCacheTokenRow | AiCacheCostRow;

/** 解码后的统计文件；rows 保留文件中的顺序。 */
interface AiCacheDocument {
  readonly summary: AiCacheSummary | null;
  readonly rows: ReadonlyMap<string, AiCacheRow>;
}

/** 一次只读探测的结果：解码内容、需要原子发布的规范化文本与追加游标。 */
export interface AiCacheInspection {
  readonly document: AiCacheDocument;
  readonly rewriteContent: string | null;
  readonly state: AppendOnlyFileState;
}

/** 可累加的合计；命中率在输出时才计算，costInUsdTicks 在计入第一条费用请求前为 undefined。 */
interface MutableTotals {
  requests: number;
  inputTokens: number;
  reportedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costInUsdTicks: number | undefined;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalid(reason: string): never {
  throw new AppendOnlyFileFormatError(AI_CACHE_FILE_PATH, reason);
}

function decodeRow(key: string, value: unknown): AiCacheRow {
  if (
    !isPlainRecord(value) ||
    typeof value.capability !== "string" || !AI_CACHE_CAPABILITIES.has(value.capability) ||
    (value.provider !== "openai" && value.provider !== "google") ||
    typeof value.model !== "string" || value.model.length === 0
  ) {
    return invalid(`contains an invalid usage record for key ${key}.`);
  }
  if (hasExactKeys(value, AI_CACHE_COST_ROW_FIELDS)) {
    if (!isTokenCount(value.costInUsdTicks)) return invalid(`contains an invalid usage record for key ${key}.`);
    return {
      capability: value.capability as AiCacheCapability,
      provider: value.provider,
      model: value.model,
      costInUsdTicks: value.costInUsdTicks,
    };
  }
  if (
    !hasExactKeys(value, AI_CACHE_ROW_FIELDS) ||
    !isTokenCount(value.inputTokens) ||
    (value.cachedInputTokens !== null &&
      (!isTokenCount(value.cachedInputTokens) || value.cachedInputTokens > value.inputTokens)) ||
    !isTokenCount(value.outputTokens)
  ) {
    return invalid(`contains an invalid usage record for key ${key}.`);
  }
  return {
    capability: value.capability as AiCacheCapability,
    provider: value.provider,
    model: value.model,
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
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
 * 解码一份合计。keys 是该对象的必填字段（汇总本身比 byModel 分组多 day 与 byModel），
 * costInUsdTicks 可缺省；命中数不得超过有缓存口径的输入数，后者不得超过总输入数，命中率
 * 必须等于按同一口径重算的值。
 */
function decodeTotals(value: unknown, keys: readonly string[], field: string): AiCacheTotals {
  if (
    !isPlainRecord(value) ||
    !hasTotalsKeys(value, keys) ||
    (value.costInUsdTicks !== undefined && !isTokenCount(value.costInUsdTicks)) ||
    !isTokenCount(value.requests) ||
    !isTokenCount(value.inputTokens) ||
    !isTokenCount(value.reportedInputTokens) ||
    !isTokenCount(value.cachedInputTokens) ||
    !isTokenCount(value.outputTokens) ||
    value.reportedInputTokens > value.inputTokens ||
    value.cachedInputTokens > value.reportedInputTokens ||
    value.cacheHitRate !== hitRate(value.cachedInputTokens, value.reportedInputTokens)
  ) {
    return invalid(`contains invalid totals at ${field}.`);
  }
  return {
    requests: value.requests,
    inputTokens: value.inputTokens,
    reportedInputTokens: value.reportedInputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    cacheHitRate: hitRate(value.cachedInputTokens, value.reportedInputTokens),
    costInUsdTicks: value.costInUsdTicks,
  };
}

function isGroupKey(group: string): boolean {
  const match: RegExpExecArray | null = AI_CACHE_GROUP_KEY_PATTERN.exec(group);
  return match !== null && AI_CACHE_CAPABILITIES.has(match[1]!);
}

function decodeSummary(value: unknown): AiCacheSummary {
  if (!isPlainRecord(value) || typeof value.day !== "string" || !isCanonicalDateKey(value.day)) {
    return invalid(`contains an invalid ${AI_CACHE_SUMMARY_KEY}.day.`);
  }
  if (!isPlainRecord(value.byModel)) return invalid(`contains an invalid ${AI_CACHE_SUMMARY_KEY}.byModel.`);
  const byModel: Record<string, AiCacheTotals> = Object.create(null) as Record<string, AiCacheTotals>;
  for (const [group, totals] of Object.entries(value.byModel)) {
    if (!isGroupKey(group)) return invalid(`contains an invalid ${AI_CACHE_SUMMARY_KEY}.byModel key ${group}.`);
    byModel[group] = decodeTotals(totals, AI_CACHE_TOTALS_FIELDS, `${AI_CACHE_SUMMARY_KEY}.byModel.${group}`);
  }
  return {
    day: value.day,
    ...decodeTotals(value, AI_CACHE_SUMMARY_FIELDS, AI_CACHE_SUMMARY_KEY),
    byModel,
  };
}

function decodeDocument(parsed: unknown): AiCacheDocument {
  if (!isPlainRecord(parsed)) return invalid("must contain a top-level JSON object.");
  let summary: AiCacheSummary | null = null;
  const rows: Map<string, AiCacheRow> = new Map();
  let index: number = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (key === AI_CACHE_SUMMARY_KEY) {
      if (index !== 0) invalid(`must put ${AI_CACHE_SUMMARY_KEY} first.`);
      summary = decodeSummary(value);
    } else if (AI_CACHE_ROW_KEY_PATTERN.test(key)) {
      rows.set(key, decodeRow(key, value));
    } else {
      invalid(`contains an unknown key ${key}.`);
    }
    index++;
  }
  return { summary, rows };
}

/** 只读探测统计文件：裁掉撕裂尾部并严格解码，不写盘。 */
export async function inspectAiCacheFile(): Promise<AiCacheInspection> {
  const inspection: RepairableAppendOnlyInspection<AiCacheDocument> | null =
    await inspectRepairableAppendOnlyFile(AI_CACHE_FILE_PATH, decodeDocument);
  if (inspection === null) {
    return {
      document: { summary: null, rows: new Map() },
      rewriteContent: null,
      state: { size: 0, empty: true },
    };
  }
  return {
    document: inspection.decoded,
    rewriteContent: inspection.rewriteContent,
    state: inspection.state,
  };
}

/** 发布探测时预计算的规范化内容，并返回可追加的游标。 */
function publishInspection(inspection: AiCacheInspection): AppendOnlyFileState {
  if (inspection.rewriteContent !== null) atomicWriteTextSync(AI_CACHE_FILE_PATH, inspection.rewriteContent);
  return { size: inspection.state.size, empty: inspection.state.empty };
}

/** 跨域启动 inspect 全部成功后接管统计文件。 */
export function adoptAiCacheFile(inspection: AiCacheInspection): void {
  resetAiCacheState();
  mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
  aiCacheFileState.current = publishInspection(inspection);
}

/** 启动成功后清掉原子重写留下的孤儿临时文件，并补做错过的每日汇总。 */
export async function maintainAiCacheFile(): Promise<void> {
  if (inspectOptionalDirectory(AI_CACHE_MEMORY_DIR)) {
    await removeOrphanedTempFiles(
      AI_CACHE_MEMORY_DIR,
      readdirSync(AI_CACHE_MEMORY_DIR),
      `.${basename(AI_CACHE_FILE_PATH)}.`
    );
  }
  await summarizeAiCache();
}

/** 收下一条用量：序列化进缓冲，达到阈值立即刷盘，否则按需排定时刷盘。 */
export async function handleAiCacheUsageMessage(message: AiCacheUsageDiskMessage): Promise<void> {
  const row: AiCacheRow = message.kind === "cost"
    ? {
      capability: message.capability,
      provider: message.provider,
      model: message.model,
      costInUsdTicks: message.costInUsdTicks,
    }
    : {
      capability: message.capability,
      provider: message.provider,
      model: message.model,
      inputTokens: message.inputTokens,
      cachedInputTokens: message.cachedInputTokens,
      outputTokens: message.outputTokens,
    };
  aiCacheBuffer.texts.push(serializeDayFileEntry(
    `${formatTokyoLogTimestamp(message.timestamp)}_${crypto.randomUUID()}`,
    row
  ));
  if (aiCacheBuffer.texts.length >= FLUSH_MAX_ENTRIES) await flushAiCacheBuffer();
  else armDiskIOFlushTimer(aiCacheBuffer, FLUSH_INTERVAL_MS, flushAiCacheBuffer);
}

/**
 * 把缓冲里的记录一次追加到文件末尾。游标失效时先重新探测；上一次失败仍在退避窗口内
 * 或本次失败时丢弃这一批并返回 false。
 */
export async function flushAiCacheBuffer(): Promise<boolean> {
  cancelDiskIOFlushTimer(aiCacheBuffer);
  if (aiCacheBuffer.texts.length === 0) return true;
  const texts: string[] = aiCacheBuffer.texts;
  aiCacheBuffer.texts = [];
  const now: number = Date.now();
  if (aiCacheFileState.current === null && now < aiCacheReopenState.retryAt) return false;
  try {
    if (aiCacheFileState.current === null) {
      mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
      aiCacheFileState.current = publishInspection(await inspectAiCacheFile());
    }
    await appendToAppendOnlyFile({
      path: AI_CACHE_FILE_PATH,
      state: aiCacheFileState.current,
      chunk: texts.join(",\n"),
      repair: true,
    });
    aiCacheReopenState.retryAt = 0;
    return true;
  } catch (error: unknown) {
    aiCacheFileState.current = null;
    aiCacheReopenState.retryAt = now + LOG_REOPEN_RETRY_MS;
    console.error("[diskIOWorker] AI cache usage flush failed:", error);
    return false;
  }
}

function emptyTotals(): MutableTotals {
  return {
    requests: 0,
    inputTokens: 0,
    reportedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costInUsdTicks: undefined,
  };
}

function addRow(totals: MutableTotals, row: AiCacheRow): void {
  totals.requests += 1;
  if ("costInUsdTicks" in row) {
    totals.costInUsdTicks = (totals.costInUsdTicks ?? 0) + row.costInUsdTicks;
    return;
  }
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
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
  if (other.costInUsdTicks !== undefined) {
    totals.costInUsdTicks = (totals.costInUsdTicks ?? 0) + other.costInUsdTicks;
  }
}

function finishTotals(totals: MutableTotals): AiCacheTotals {
  return {
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    reportedInputTokens: totals.reportedInputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    outputTokens: totals.outputTokens,
    cacheHitRate: hitRate(totals.cachedInputTokens, totals.reportedInputTokens),
    costInUsdTicks: totals.costInUsdTicks,
  };
}

/**
 * 把 day 当天的记录汇总成一份 summary；previous 是同一天已有的汇总时相加。
 * byModel 按键排序，键为 `<capability>/<provider>/<model>`。
 */
function buildSummary(
  day: string,
  rows: readonly AiCacheRow[],
  previous: AiCacheSummary | null
): AiCacheSummary {
  const overall: MutableTotals = emptyTotals();
  const groups: Map<string, MutableTotals> = new Map();
  if (previous !== null) {
    addTotals(overall, previous);
    for (const [group, totals] of Object.entries(previous.byModel)) {
      const merged: MutableTotals = emptyTotals();
      addTotals(merged, totals);
      groups.set(group, merged);
    }
  }
  for (const row of rows) {
    addRow(overall, row);
    const group: string = `${row.capability}/${row.provider}/${row.model}`;
    let totals: MutableTotals | undefined = groups.get(group);
    if (totals === undefined) {
      totals = emptyTotals();
      groups.set(group, totals);
    }
    addRow(totals, row);
  }
  const byModel: Record<string, AiCacheTotals> = {};
  for (const group of [...groups.keys()].sort()) byModel[group] = finishTotals(groups.get(group)!);
  return { day, ...finishTotals(overall), byModel };
}

/**
 * 每日汇总：先刷缓冲，再把 today 之前的记录汇总成其中最近一天的 summary（与同日已有汇总
 * 相加），删掉这些记录与更早的汇总后整份原子重写。没有 today 之前的记录时不写盘。
 * @param today 东京日期；缺省为当前时刻。
 */
export async function summarizeAiCache(today: string = getTokyoDateKey()): Promise<void> {
  await flushAiCacheBuffer();
  const inspection: AiCacheInspection = await inspectAiCacheFile();
  const kept: Record<string, AiCacheRow> = {};
  const pastRows: Map<string, AiCacheRow[]> = new Map();
  let latestDay: string = "";
  for (const [key, row] of inspection.document.rows) {
    const day: string = key.slice(0, 10);
    if (day >= today) {
      kept[key] = row;
      continue;
    }
    let rows: AiCacheRow[] | undefined = pastRows.get(day);
    if (rows === undefined) {
      rows = [];
      pastRows.set(day, rows);
    }
    rows.push(row);
    if (day > latestDay) latestDay = day;
  }
  if (latestDay === "") {
    if (inspection.rewriteContent !== null) aiCacheFileState.current = publishInspection(inspection);
    return;
  }
  const previous: AiCacheSummary | null = inspection.document.summary;
  const summary: AiCacheSummary = previous !== null && previous.day > latestDay
    ? previous
    : buildSummary(latestDay, pastRows.get(latestDay)!, previous?.day === latestDay ? previous : null);
  const content: string = JSON.stringify({ [AI_CACHE_SUMMARY_KEY]: summary, ...kept }, null, DAY_FILE_JSON_INDENT);
  mkdirSync(AI_CACHE_MEMORY_DIR, { recursive: true });
  atomicWriteTextSync(AI_CACHE_FILE_PATH, content);
  aiCacheFileState.current = { size: Buffer.byteLength(content), empty: false };
}
