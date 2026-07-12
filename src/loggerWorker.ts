/**
 * 日志落盘线程（Bun Worker）。接收 logger.ts 发来的 error 日志，先进入
 * 内存 buffer，攒满 FLUSH_MAX_ENTRIES 条、距首条入队 FLUSH_INTERVAL_MS、
 * 或收到主线程的 flush 指令（进程退出前的最后一刷）时批量落盘到
 * logs/YYYY-MM-DD.json：文件内容是一个 JSON 对象，键为
 * 「本地日期时间_uuid」（如 2026-07-12 11:48:25.123_9f…），值为该条日志的
 * 内容对象，与 JSON.stringify(entries, null, 2) 的输出逐字节一致。
 *
 * 键按时间单调递增，新条目永远位于对象末尾，因此落盘不整文件重写，
 * 而是覆写文件结尾的「\n}」两个字节、按位置追加，写入量只与本批条数
 * 有关，与文件大小无关。仅保留最近 3 天（今天及之前两天）的文件，跨天
 * 时自动清理过期文件。日期按系统本地时区划分（本机已设为 Asia/Tokyo）。
 */

import { join } from "path";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "fs";
import type { FlushReply, FlushRequest, LogMessage } from "./logger";

declare var self: Worker;

const LOGS_DIR: string = join(import.meta.dir, "..", "logs");
const RETENTION_DAYS: number = 3;

const FLUSH_MAX_ENTRIES: number = 150;
const FLUSH_INTERVAL_MS: number = 60_000;

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

function dayPath(day: string): string {
  return join(LOGS_DIR, `${day}.json`);
}

/**
 * 把单条日志序列化成顶层对象里的一段文本（含 2 空格缩进、不含前后逗号），
 * 与 JSON.stringify(整个对象, null, 2) 中该条目的形态完全一致。实现上借
 * 单条目对象的 stringify 结果，掐掉外层的「{\n」和「\n}」。
 */
function serializeEntry(key: string, record: LogRecord): string {
  return JSON.stringify({ [key]: record }, null, 2).slice(2, -2);
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

/** 当前追加目标文件的状态：字节大小用于定位结尾的「\n}」。 */
interface DayFileState {
  day: string;
  size: number;
  empty: boolean;
}

let current: DayFileState | null = null;

/**
 * 打开（或接管）某天的文件并校验其可追加性。文件不存在或为空对象视作
 * 空文件；内容合法但结尾形态不符（比如被人手动编辑过）就按标准格式重写
 * 一次；解析失败（上次写入中断等）则放弃旧内容从头开始，和旧实现一致。
 */
function openDay(day: string): DayFileState {
  const path: string = dayPath(day);
  const state: DayFileState = { day, size: 0, empty: true };
  if (!existsSync(path)) return state;
  try {
    const content: string = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Object.keys(parsed).length === 0) return state;
    if (content.endsWith("\n}")) {
      state.size = Buffer.byteLength(content);
    } else {
      const canonical: string = JSON.stringify(parsed, null, 2);
      writeFileSync(path, canonical);
      state.size = Buffer.byteLength(canonical);
    }
    state.empty = false;
  } catch {
    // 文件损坏就从空文件重新开始，不让日志线程崩掉。
  }
  return state;
}

/** 把一批已序列化的条目追加到某天的文件末尾（覆写结尾的「\n}」）。 */
function appendChunk(state: DayFileState, chunk: string): void {
  const path: string = dayPath(state.day);
  if (state.empty) {
    const content: string = `{\n${chunk}\n}`;
    writeFileSync(path, content);
    state.size = Buffer.byteLength(content);
    state.empty = false;
    return;
  }
  const data: string = `,\n${chunk}\n}`;
  const fd: number = openSync(path, "r+");
  try {
    writeSync(fd, data, state.size - 2, "utf8");
  } finally {
    closeSync(fd);
  }
  state.size = state.size - 2 + Buffer.byteLength(data);
}

function writeDay(day: string, texts: string[]): void {
  if (texts.length === 0) return;
  try {
    if (current === null || current.day !== day) {
      current = openDay(day);
      cleanupOldLogs();
    }
    appendChunk(current, texts.join(",\n"));
  } catch (err) {
    // 本批写入失败就丢弃（控制台/journal 里仍有原始输出），并重置状态
    // 让下次 flush 重新校验文件，避免在损坏的结尾上继续追加。
    current = null;
    console.error("[loggerWorker] 落盘失败：", err);
  }
}

// 内存 buffer：onmessage 只做序列化后入队，满 FLUSH_MAX_ENTRIES 条立即
// 落盘，否则由首条入队时启动的定时器在 FLUSH_INTERVAL_MS 后统一落盘。
let buffer: { day: string; text: string }[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const entries = buffer;
  buffer = [];
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

mkdirSync(LOGS_DIR, { recursive: true });
cleanupOldLogs();

self.onmessage = (event: MessageEvent<LogMessage | FlushRequest>) => {
  const msg: LogMessage | FlushRequest = event.data;
  // 落盘指令（进程退出前的最后一刷）：立即 flush 并回执。消息按 FIFO
  // 处理，此前收到的日志此刻都已在 buffer 里，flush 完即全部落盘。
  if ("flushId" in msg) {
    flush();
    const reply: FlushReply = { flushedId: msg.flushId };
    self.postMessage(reply);
    return;
  }
  const record: LogRecord = {
    level: msg.level,
    message: msg.args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" "),
    args: msg.args,
  };
  buffer.push({
    day: dayKey(msg.timestamp),
    text: serializeEntry(`${formatDateTime(msg.timestamp)}_${crypto.randomUUID()}`, record),
  });
  if (buffer.length >= FLUSH_MAX_ENTRIES) {
    flush();
  } else if (flushTimer === null) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
};
