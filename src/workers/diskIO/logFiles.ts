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
 * 仅保留 RETENTION_DAYS 天内的文件（见 consts/diskIO/appendOnly.ts），跨天时自动清理
 * 过期文件。日期显式按东京时区划分（同 libs/time.ts 的 getTokyoDateKey，
 * 与运势/AI 记忆两个同进程内子系统口径一致），不依赖部署机器自身的系统
 * 时区设置——不然一旦部署环境时区漂移，三类落盘数据会在同一次事故里表现
 * 不一致（其余两类原本就显式用东京时区计算）。
 *
 * 本文件从原 src/workers/loggerWorker.ts 搬迁而来，落盘机制后续抽成了
 * diskIO/appendOnlyDayFile.ts，本文件自身的日志领域逻辑（buffer/阈值/
 * 保留期）无变化。
 */

import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { LogMessage } from "../../types";
import { LOGS_DIR, TMP_FILE_SUFFIX } from "../../consts/paths";
import { DAY_FILE_PATTERN, FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES, RETENTION_DAYS } from "../../consts/diskIO/appendOnly";
import { flushBuffer, loggerFileState, markLogDirty, resetLogCache } from "../../cache/diskIO/logs";
import { getTokyoDateKey } from "../../libs/time";
import { appendToDayFile, openDayFile, serializeDayFileEntry } from "./appendOnlyDayFile";

interface LogRecord {
  level: string;
  message: string;
  /** 原始参数列表。只在存在非字符串参数（展开后的 Error 对象等结构化数据）
   *  时落盘；纯字符串参数已逐字进了 message，再存一份 args 纯属重复，见
   *  handleLogMessage 里的判断。 */
  args?: unknown[];
}

/** 东京时区、含毫秒的日期时间格式器（模块加载时构造一次复用，同 libs/time.ts
 *  的 TOKYO_TIME_FORMATTER 一个道理）。libs/time.ts 的 formatTokyoTime 没有
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
function cleanupStaleTmpFiles(): void {
  for (const name of readdirSync(LOGS_DIR)) {
    if (!name.endsWith(TMP_FILE_SUFFIX)) continue;
    try {
      unlinkSync(join(LOGS_DIR, name));
    } catch {
      // 删除失败（权限问题等）不影响主流程，下次启动同样的清理还会再试一次。
    }
  }
}

/** 删除超出保留期的日志文件（保留今天在内的最近 RETENTION_DAYS 天）。 */
function cleanupOldLogs(): void {
  const oldestKept: string = dayKey(Date.now() - (RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000);
  for (const name of readdirSync(LOGS_DIR)) {
    const match = DAY_FILE_PATTERN.exec(name);
    if (match && match[1]! < oldestKept) {
      try {
        unlinkSync(join(LOGS_DIR, name));
      } catch {
        // 删除失败（例如权限问题）不影响写入，下次跨天再试。
      }
    }
  }
}

function writeDay(day: string, texts: string[]): void {
  if (texts.length === 0) return;
  try {
    if (loggerFileState.current?.day !== day) {
      loggerFileState.current = openDayFile(LOGS_DIR, day);
      cleanupOldLogs();
    }
    appendToDayFile(LOGS_DIR, loggerFileState.current, texts.join(",\n"));
  } catch (err) {
    // 本批写入失败就丢弃（控制台/journal 里仍有原始输出），并重置状态
    // 让下次 flush 重新校验文件，避免在损坏的结尾上继续追加。
    loggerFileState.current = null;
    console.error("[diskIOWorker] flush to disk failed:", err);
  }
}

/** 目录初始化 + 首次清理，由 diskIOWorker.ts 在模块加载时调用一次。 */
export function initLogFiles(): void {
  resetLogCache();
  mkdirSync(LOGS_DIR, { recursive: true });
  cleanupStaleTmpFiles();
  cleanupOldLogs();
}

/** 立即把内存 buffer 落盘（日志自身阈值触发，或统一 flush 指令触发时调用）。 */
export function flushLogBuffer(): void {
  if (flushBuffer.timer !== null) {
    clearTimeout(flushBuffer.timer);
    flushBuffer.timer = null;
  }
  if (flushBuffer.entries.length === 0) return;
  const entries = flushBuffer.entries;
  flushBuffer.entries = [];
  // 按天分组落盘（保持顺序），只有跨天瞬间的那批会拆成两组。
  let day: string = entries[0]!.day;
  let texts: string[] = [];
  for (const entry of entries) {
    if (entry.day !== day) {
      writeDay(day, texts);
      day = entry.day;
      texts = [];
    }
    texts.push(entry.text);
  }
  writeDay(day, texts);
}

/** 处理一条日志消息：入内存 buffer，达到阈值立即落盘，否则按需启动定时器。 */
export function handleLogMessage(msg: LogMessage): void {
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
  const bufferedEntries: number = markLogDirty({
    day: dayKey(msg.timestamp),
    text: serializeDayFileEntry(`${formatDateTime(msg.timestamp)}_${crypto.randomUUID()}`, record),
  });
  if (bufferedEntries >= FLUSH_MAX_ENTRIES) {
    flushLogBuffer();
  } else {
    flushBuffer.timer ??= setTimeout(flushLogBuffer, FLUSH_INTERVAL_MS);
  }
}
