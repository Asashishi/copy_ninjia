/**
 * 日志落盘逻辑：接收 diskIOWorker.ts 路由来的日志消息，先进入内存 buffer，
 * 达到阈值（见 consts/diskIO.ts 的 FLUSH_MAX_ENTRIES/FLUSH_INTERVAL_MS）或
 * 收到统一 flush 指令时批量落盘到 logs/YYYY-MM-DD.json：文件内容是一个
 * JSON 对象，键为「本地日期时间_uuid」（如 2026-07-12 11:48:25.123_9f…），
 * 值为该条日志的内容对象，与 JSON.stringify(entries, null, 2) 的输出逐字节
 * 一致。
 *
 * 键按时间单调递增，新条目永远位于对象末尾，因此落盘不整文件重写——具体的
 * 按位置追加/损坏修复机制见 diskIO/appendOnlyDayFile.ts（与每日运势共用）。
 * 仅保留 RETENTION_DAYS 天内的文件（见 consts/diskIO.ts），跨天时自动清理
 * 过期文件。日期按系统本地时区划分（本机已设为 Asia/Tokyo）。
 *
 * 本文件从原 src/workers/loggerWorker.ts 搬迁而来，落盘机制后续抽成了
 * diskIO/appendOnlyDayFile.ts，本文件自身的日志领域逻辑（buffer/阈值/
 * 保留期）无变化。
 */

import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { LogMessage } from "../../types";
import { LOGS_DIR } from "../../consts/paths";
import { DAY_FILE_PATTERN, FLUSH_INTERVAL_MS, FLUSH_MAX_ENTRIES, RETENTION_DAYS } from "../../consts/diskIO";
import { flushBuffer, loggerFileState } from "../../cache/diskIOWorker";
import { appendToDayFile, openDayFile, serializeDayFileEntry } from "./appendOnlyDayFile";

interface LogRecord {
  level: string;
  message: string;
  /** 原始参数列表。当它相对 message 没有任何额外信息（单个字符串参数，
   *  message 就是它本身）时省略不写，见 handleLogMessage 里的判断。 */
  args?: unknown[];
}

function pad(n: number, width: number = 2): string {
  return String(n).padStart(width, "0");
}

/** 毫秒时间戳 → 本地时区的「YYYY-MM-DD HH:mm:ss.SSS」。 */
function formatDateTime(timestamp: number): string {
  const d: Date = new Date(timestamp);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** 毫秒时间戳 → 本地时区的日期串（YYYY-MM-DD），用作日志文件名。 */
function dayKey(timestamp: number): string {
  return formatDateTime(timestamp).slice(0, 10);
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
    if (loggerFileState.current === null || loggerFileState.current.day !== day) {
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
  mkdirSync(LOGS_DIR, { recursive: true });
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
  const message: string = msg.args
    .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
    .join(" ");
  const record: LogRecord = { level: msg.level, message };
  // message 本就是把 args 逐个字符串化拼出来的：调用方只传一个字符串时
  // （本仓库最常见的写法）两者逐字相同，再存一份 args 纯属重复；只有
  // 多参数或非字符串参数（如展开后的 Error 对象，堆栈只存在于 args 里）
  // 时 args 才有额外信息，才值得落盘。
  if (!(msg.args.length === 1 && msg.args[0] === message)) {
    record.args = msg.args;
  }
  flushBuffer.entries.push({
    day: dayKey(msg.timestamp),
    text: serializeDayFileEntry(`${formatDateTime(msg.timestamp)}_${crypto.randomUUID()}`, record),
  });
  if (flushBuffer.entries.length >= FLUSH_MAX_ENTRIES) {
    flushLogBuffer();
  } else if (flushBuffer.timer === null) {
    flushBuffer.timer = setTimeout(flushLogBuffer, FLUSH_INTERVAL_MS);
  }
}
