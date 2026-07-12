/**
 * 日志落盘线程（Bun Worker）。接收 logger.ts 发来的 error 日志，先进入
 * 内存队列，由 flush 循环异步批量写入 logs/YYYY-MM-DD.json：文件内容是
 * 一个 JSON 对象，键为「本地日期时间_uuid」（如 2026-07-12 11:48:25.123_9f…），
 * 值为该条日志的内容对象。仅保留最近 3 天（今天及之前两天）的文件，跨天
 * 时自动清理过期文件。日期按系统本地时区划分（本机已设为 Asia/Tokyo）。
 */

import { join } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { LinkedQueue } from "./linkedQueue";
import type { LogMessage } from "./logger";

declare var self: Worker;

const LOGS_DIR: string = join(import.meta.dir, "..", "logs");
const RETENTION_DAYS: number = 3;

const DAY_FILE_PATTERN: RegExp = /^(\d{4}-\d{2}-\d{2})\.json$/;

interface LogRecord {
  level: string;
  message: string;
  args: unknown[];
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

// 当前正在写的日期及其文件内容缓存。error 日志频率很低，每次 flush 后
// 整体重写当天文件即可。
let cachedDay: string = "";
let cachedEntries: Record<string, LogRecord> = {};
let dirty: boolean = false;

function loadDay(day: string): void {
  cachedDay = day;
  cachedEntries = {};
  dirty = false;
  const filePath: string = join(LOGS_DIR, `${day}.json`);
  if (!existsSync(filePath)) return;
  try {
    cachedEntries = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    // 文件损坏就从空对象重新开始，不让日志线程崩掉。
  }
}

async function writeCache(): Promise<void> {
  if (!dirty || !cachedDay) return;
  dirty = false;
  await Bun.write(join(LOGS_DIR, `${cachedDay}.json`), JSON.stringify(cachedEntries, null, 2));
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

// 写入队列：onmessage 只入队，flush 循环异步消费。一次 flush 期间新到的
// 日志会合并进同一轮循环，落盘次数与日志条数解耦。
const pending: LinkedQueue<LogMessage> = new LinkedQueue();
let flushing: boolean = false;

async function flushQueue(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (pending.size > 0) {
      let msg: LogMessage | undefined;
      while ((msg = pending.shift()) !== undefined) {
        const day: string = dayKey(msg.timestamp);
        if (day !== cachedDay) {
          await writeCache();
          loadDay(day);
          cleanupOldLogs();
        }
        cachedEntries[`${formatDateTime(msg.timestamp)}_${crypto.randomUUID()}`] = {
          level: msg.level,
          message: msg.args
            .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
            .join(" "),
          args: msg.args,
        };
        dirty = true;
      }
      await writeCache();
    }
  } finally {
    flushing = false;
  }
}

mkdirSync(LOGS_DIR, { recursive: true });
cleanupOldLogs();

self.onmessage = (event: MessageEvent<LogMessage>) => {
  pending.push(event.data);
  void flushQueue();
};
