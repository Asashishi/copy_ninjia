/**
 * 日志落盘逻辑：接收 diskIOWorker.ts 路由来的日志消息，先进入内存 buffer，
 * 达到阈值（见 consts/diskIO/appendOnly.ts）或
 * 收到统一 flush 指令时批量落盘到 logs/YYYY-MM-DD.json：文件内容是一个
 * JSON 对象，键为「本地日期时间_uuid」（如 2026-07-12 11:48:25.123_9f…），
 * 值为该条日志的内容对象，与 JSON.stringify(entries, null, 2) 的输出逐字节
 * 一致。
 *
 * 键按时间单调递增，新条目永远位于对象末尾，因此落盘不整文件重写——具体的
 * 按位置追加/损坏修复机制见 diskIO/appendOnlyDayFile.ts。
 * 仅保留 RETENTION_DAYS 天内的文件（见 consts/diskIO/appendOnly.ts），跨天写入
 * 与每日维护都会清理过期文件。日期显式按东京时区划分（同 libs/time.ts 的 getTokyoDateKey，
 * 与运势/AI 记忆两个同进程内子系统口径一致），不依赖部署机器自身的系统
 * 时区设置——不然一旦部署环境时区漂移，三类落盘数据会在同一次事故里表现
 * 不一致。
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LogMessage } from "../../types/diskIO/messages";
import type { DayFileState } from "../../types/diskIO/storage";
import { LOGS_DIR, TMP_FILE_SUFFIX } from "../../consts/paths";
import {
  DAY_FILE_PATTERN,
  DAY_FILE_JSON_INDENT,
  FLUSH_INTERVAL_MS,
  FLUSH_MAX_ENTRIES,
  LOG_REOPEN_RETRY_MS,
  RETENTION_DAYS,
} from "../../consts/diskIO/appendOnly";
import { DAY_MS } from "../../consts/diskIO/common";
import { flushBuffer, loggerFileState, loggerReopenState, markLogDirty, resetLogCache } from "../../cache/workers/diskIO/logs";
import { getTokyoDateKey } from "../../libs/time";
import { isPlainRecord } from "../../libs/record";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { assertFileReadableWritable } from "../../libs/fileAccess";
import { readUtf8TextInput } from "../../libs/inputValidation";
import {
  AppendOnlyFileFormatError,
  appendToDayFile,
  repairTruncatedAppendOnlyContent,
  serializeDayFileEntry,
} from "./appendOnlyDayFile";
import type { BufferedLogEntry } from "../../types/diskIO/storage";
import { enqueueDiskIOOperation } from "./operationQueue";

interface LogRecord {
  level: string;
  message: string;
  /** 原始参数列表。只在存在非字符串参数（展开后的 Error 对象等结构化数据）
   *  时落盘；纯字符串参数已逐字进了 message，再存一份 args 纯属重复，见
   *  handleLogMessage 里的判断。 */
  args?: unknown[];
}

/** 东京时区、含毫秒的日期时间格式器（模块加载时构造一次复用，同 libs/time.ts
 *  里那几个模块级格式器一个道理）。libs/time.ts 的 formatTokyoTime 没有
 *  毫秒精度、分隔符也不同（"/" 而非 "-"），日志 key 需要毫秒来对齐同一秒内
 *  多条日志的先后顺序，所以这里单独维护一份，不复用它。 */
const TOKYO_DATETIME_MS_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

function assertLogFileSchema(path: string, parsed: unknown): void {
  if (!isPlainRecord(parsed)) {
    throw new AppendOnlyFileFormatError(path, "must contain a top-level JSON object.");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (
      !isPlainRecord(value) ||
      typeof value.level !== "string" ||
      typeof value.message !== "string" ||
      (value.args !== undefined && !Array.isArray(value.args))
    ) {
      throw new AppendOnlyFileFormatError(path, `contains an invalid log record for key ${key}.`);
    }
  }
}

/**
 * 接管某日日志前校验领域 schema。可解析的错误结构在通用格式化发生前就拒绝，
 * 保证原字节不变；截断内容则先由 openDayFile 修复，再校验修复结果。两次完整
 * 读取只发生在启动、跨日打开，以及追加失败后按 LOG_REOPEN_RETRY_MS 退避的那次
 * 重试上；追加热路径不调用本函数。
 */
interface LogDayInspection {
  readonly state: DayFileState;
  readonly path: string;
  readonly rewriteContent: string | null;
}

async function inspectLogDay(day: string): Promise<LogDayInspection> {
  const path: string = join(LOGS_DIR, `${day}.json`);
  if (!await Bun.file(path).exists()) {
    return {
      path,
      rewriteContent: null,
      state: { day, size: 0, empty: true },
    };
  }
  assertFileReadableWritable(path);
  const content: string = await readUtf8TextInput(path);
  let parsed: unknown;
  let rewriteContent: string | null = null;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    rewriteContent = repairTruncatedAppendOnlyContent(content);
    if (rewriteContent === null) {
      throw new AppendOnlyFileFormatError(path, "could not be parsed or repaired.");
    }
    parsed = JSON.parse(rewriteContent) as unknown;
  }
  assertLogFileSchema(path, parsed);
  const empty: boolean = Object.keys(parsed as Record<string, unknown>).length === 0;
  if (!empty && rewriteContent === null && !content.endsWith("\n}")) {
    rewriteContent = JSON.stringify(parsed, null, DAY_FILE_JSON_INDENT);
  }
  return {
    path,
    rewriteContent,
    state: {
      day,
      size: empty
        ? 0
        : rewriteContent === null
          ? (await Bun.file(path).stat()).size
          : Buffer.byteLength(rewriteContent),
      empty,
    },
  };
}

function adoptLogDay(inspection: LogDayInspection): DayFileState {
  if (inspection.rewriteContent !== null) {
    atomicWriteTextSync(inspection.path, inspection.rewriteContent);
  }
  return inspection.state;
}

async function openLogDay(day: string): Promise<DayFileState> {
  return adoptLogDay(await inspectLogDay(day));
}

/** 毫秒时间戳 → 东京时区的「YYYY-MM-DD HH:mm:ss.SSS」，用作落盘日志条目的
 *  key（人类可读部分；同一毫秒内的多条日志靠后缀的 UUID 区分，见
 *  handleLogMessage）。用 formatToParts 手工拼接，不依赖某个 locale 恰好
 *  输出这个分隔符形态。 */
function formatDateTime(timestamp: number): string {
  const parts: Record<string, string> = {};
  for (const part of TOKYO_DATETIME_MS_FORMATTER.formatToParts(timestamp)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`;
}

/** 毫秒时间戳 → 东京时区的日期串（YYYY-MM-DD），用作日志文件名与保留期阈值计算。 */
function dayKey(timestamp: number): string {
  return getTokyoDateKey(new Date(timestamp));
}

/**
 * 清掉 LOGS_DIR 下残留的 *.tmp：openDayFile 的维护性重写（appendOnlyDayFile.ts
 * 的 atomicRewrite）走 tmp + rename，正常情况 rename 后 tmp 不会留下；只有
 * 进程恰好在 writeFileSync 与 renameSync 之间被杀、或 rename 本身失败（磁盘
 * 满等）才会留下孤儿文件。DAY_FILE_PATTERN 只匹配 <day>.json，不匹配
 * <day>.json.tmp，保留期清理天然覆盖不到，得单独扫一遍删掉——对齐
 * snapshotFiles.ts 的 recoverAiMemories/recoverLuckDay 同样的清理。
 */
async function cleanupStaleTmpFiles(names: readonly string[] = readdirSync(LOGS_DIR)): Promise<void> {
  for (const name of names) {
    if (!name.endsWith(TMP_FILE_SUFFIX)) continue;
    try {
      await Bun.file(join(LOGS_DIR, name)).delete();
    } catch {
      // 删除失败（权限问题等）不影响主流程，下次启动同样的清理还会再试一次。
    }
  }
}

/** 删除超出保留期的日志文件（保留今天在内的最近 RETENTION_DAYS 天）。 */
async function cleanupOldLogs(names: readonly string[] = readdirSync(LOGS_DIR)): Promise<void> {
  const oldestKept: string = dayKey(Date.now() - (RETENTION_DAYS - 1) * DAY_MS);
  for (const name of names) {
    const match: RegExpExecArray | null = DAY_FILE_PATTERN.exec(name);
    if (match && match[1]! < oldestKept) {
      try {
        await Bun.file(join(LOGS_DIR, name)).delete();
      } catch {
        // 删除失败（例如权限问题）不影响写入，下次跨天再试。
      }
    }
  }
}

async function writeDay(day: string, texts: string[]): Promise<boolean> {
  if (texts.length === 0) return true;
  const now: number = Date.now();
  // 上一次追加失败后还在退避窗口内：直接丢这一批，不重走 openLogDay。磁盘满、
  // 卷转只读这类故障不会在一个 flush 周期内自愈，而重开一次要把整个日文件读两
  // 遍、逐条校验 schema、再扫一遍目录——不退避的话每个周期都要按日文件大小付
  // 一次这个代价，且故障期本身制造的 logger.error 还会把节拍压得更密。这条线程
  // 同时持有身份策略/群状态 SQLite、移除 outbox 与 AI 记忆快照（见
  // consts/diskIO/appendOnly.ts 的 LOG_REOPEN_RETRY_MS）。
  if (loggerFileState.current === null && now < loggerReopenState.retryAt) return false;
  try {
    if (loggerFileState.current?.day !== day) {
      loggerFileState.current = await openLogDay(day);
      await cleanupOldLogs();
    }
    await appendToDayFile({
      dir: LOGS_DIR,
      state: loggerFileState.current,
      chunk: texts.join(",\n"),
      repair: true,
    });
    loggerReopenState.retryAt = 0;
    return true;
  } catch (err: unknown) {
    // 本批写入失败就丢弃（控制台/journal 里仍有原始输出），并重置状态
    // 让下次 flush 重新校验文件，避免在损坏的结尾上继续追加。
    loggerFileState.current = null;
    loggerReopenState.retryAt = now + LOG_REOPEN_RETRY_MS;
    console.error("[diskIOWorker] flush to disk failed:", err);
    return false;
  }
}

export interface LogFilesInspection {
  readonly names: readonly string[];
  readonly day: LogDayInspection;
}

/** 跨域启动第一阶段：只读校验当前日志，并预计算必要的规范化内容。 */
export async function inspectLogFiles(): Promise<LogFilesInspection> {
  const names: string[] = existsSync(LOGS_DIR) ? readdirSync(LOGS_DIR) : [];
  return { names, day: await inspectLogDay(dayKey(Date.now())) };
}

/** 全域 inspect 成功后接管日志游标；可修复尾部只在这一阶段原子发布。 */
export function adoptLogFiles(inspection: LogFilesInspection): void {
  resetLogCache();
  mkdirSync(LOGS_DIR, { recursive: true });
  loggerFileState.current = adoptLogDay(inspection.day);
}

/** 启动成功后清理日志临时文件与过期日。 */
export async function maintainLogFiles(inspection: LogFilesInspection): Promise<void> {
  await cleanupStaleTmpFiles(inspection.names);
  await cleanupOldLogs(inspection.names);
}

/** 每日维护先提交内存日志，再清理孤儿临时文件与过期日文件。 */
export async function maintainLogRetention(): Promise<void> {
  if (!await flushLogBuffer()) {
    throw new Error("Failed to flush logs before daily retention maintenance.");
  }
  await cleanupStaleTmpFiles();
  await cleanupOldLogs();
}

/** 按需启动日志缓冲的定时落盘；已有定时器在跑就不重复排。条数达到
 *  FLUSH_MAX_ENTRIES 时不经过这个定时器，由 handleLogMessage 直接调
 *  flushLogBuffer 立即落盘。timer 一律 unref：有序停机由统一 flush 提前兑现，
 *  它不该单独扣住 Worker 事件循环（见 docs/cn/04-invariants.md）。 */
function scheduleLogFlush(): void {
  if (flushBuffer.timer !== null) return;
  flushBuffer.timer = setTimeout((): void => {
    void enqueueDiskIOOperation(async (): Promise<void> => {
      await flushLogBuffer();
    });
  }, FLUSH_INTERVAL_MS);
  flushBuffer.timer.unref();
}

/** 立即把内存 buffer 落盘（日志自身阈值触发，或统一 flush 指令触发时调用）。 */
export async function flushLogBuffer(): Promise<boolean> {
  if (flushBuffer.timer !== null) {
    clearTimeout(flushBuffer.timer);
    flushBuffer.timer = null;
  }
  if (flushBuffer.entries.length === 0) return true;
  const entries: BufferedLogEntry[] = flushBuffer.entries;
  flushBuffer.entries = [];
  // 按天分组落盘（保持顺序），只有跨天瞬间的那批会拆成两组。
  let day: string = entries[0]!.day;
  let texts: string[] = [];
  let clean: boolean = true;
  for (const entry of entries) {
    if (entry.day !== day) {
      clean = await writeDay(day, texts) && clean;
      day = entry.day;
      texts = [];
    }
    texts.push(entry.text);
  }
  return await writeDay(day, texts) && clean;
}

/** 处理一条日志消息：入内存 buffer，达到阈值立即落盘，否则按需启动定时器。 */
export async function handleLogMessage(msg: LogMessage): Promise<void> {
  // message 只拼字符串参数；非字符串参数（展开后的 Error 对象等）只存进
  // args，不再 stringify 一份嵌进 message——那样同一份数据会在一条记录里
  // 落两次盘（message 里一次、args 里一次），错误堆栈这种大块头尤其浪费。
  // 全是字符串参数时 message 已含全部信息，args 整个省略。
  const stringArgs: string[] = [];
  let hasStructuredArgs: boolean = false;
  for (const arg of msg.args) {
    if (typeof arg === "string") stringArgs.push(arg);
    else hasStructuredArgs = true;
  }
  const record: LogRecord = { level: msg.level, message: stringArgs.join(" ") };
  if (hasStructuredArgs) {
    record.args = msg.args;
  }
  // key 的顺序完全由前面的本地日期时间前缀决定，uuid 段只负责区分同一毫秒内的
  // 多条日志，因此这里要的是随机 id、不是可排序 id。
  const bufferedEntries: number = markLogDirty({
    day: dayKey(msg.timestamp),
    text: serializeDayFileEntry(`${formatDateTime(msg.timestamp)}_${crypto.randomUUID()}`, record),
  });
  if (bufferedEntries >= FLUSH_MAX_ENTRIES) {
    await flushLogBuffer();
  } else {
    scheduleLogFlush();
  }
}
