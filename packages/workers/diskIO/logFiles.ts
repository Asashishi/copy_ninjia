/**
 * 日志落盘逻辑：接收 diskIOWorker.ts 从诊断批路由来的日志消息，先进入内存 buffer，
 * 每个诊断批消费完、每日维护或收到统一 flush 指令时批量落盘到 logs/YYYY-MM-DD.json：文件内容是一个
 * JSON 对象，键为「配置时区的日期时间_uuid」（如 2026-07-12 11:48:25.123_9f…），
 * 值为该条日志的内容对象，与 JSON.stringify(entries, null, 2) 的输出逐字节
 * 一致。
 *
 * 键包含记录时的本地时间与独立 UUID，新条目追加到对象末尾；夏令时回拨时本地时间可重复。
 * 落盘不整文件重写——具体的
 * 按位置追加/损坏修复机制见 diskIO/appendOnlyDayFile.ts。
 * 仅保留 RETENTION_DAYS 天内的文件（见 consts/diskIO/appendOnly.ts），跨天写入
 * 与每日维护都会清理过期文件。日期与 key 前缀按配置时区划分（libs/time.ts 的
 * getDateKey、formatLogTimestamp），与部署机器的系统时区无关。
 */

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LogEnvelope } from "../../types/diskIO/messages";
import type { DayFileState, BufferedLogEntry } from "../../types/diskIO/storage";
import { LOGS_DIR } from "../../consts/paths";
import {
  DAY_FILE_PATTERN,
  LOG_REOPEN_RETRY_MS,
  RETENTION_DAYS,
} from "../../consts/diskIO/appendOnly";
import { flushBuffer, loggerFileState, loggerReopenState, markLogDirty, resetLogCache } from "../../cache/workers/diskIO/logs";
import { formatLogTimestamp, getDateKey, shiftDateKey } from "../../libs/time";
import { isPlainRecord } from "../../libs/record";
import { atomicWriteTextSync, removeOrphanedTempFiles } from "../../libs/atomicFile";
import { bestEffortUnlink, listOptionalDirectory } from "../../libs/fileAccess";
import {
  AppendOnlyFileFormatError,
  appendToDayFile,
  inspectRepairableAppendOnlyFile,
  serializeDayFileEntry,
} from "./appendOnlyDayFile";
import type { RepairableAppendOnlyInspection } from "./appendOnlyDayFile";

interface LogRecord {
  level: string;
  message: string;
  /**
   * 原始参数列表。存在非字符串参数（展开后的 Error 对象等结构化数据）时为完整
   * 参数列表，否则为 undefined；undefined 不写入日志文件。
   */
  args: unknown[] | undefined;
}

function assertLogFileSchema(path: string, parsed: unknown): void {
  if (!isPlainRecord(parsed)) {
    throw new AppendOnlyFileFormatError(path, "must contain a top-level JSON object.");
  }
  for (const [index, value] of Object.values(parsed).entries()) {
    if (
      !isPlainRecord(value) ||
      typeof value.level !== "string" ||
      typeof value.message !== "string" ||
      (value.args !== undefined && !Array.isArray(value.args))
    ) {
      throw new AppendOnlyFileFormatError(path, `entry[${index}] must be a log record with string level and message and optional array args.`);
    }
  }
}

/** 某日日志文件的只读探测结果：追加游标、路径与需要原子发布的规范化文本（无需重写时为 null）。 */
interface LogDayInspection {
  readonly state: DayFileState;
  readonly path: string;
  readonly rewriteContent: string | null;
}

/**
 * 接管某日日志前校验领域 schema。可解析的错误结构在通用格式化发生前就拒绝，
 * 保证原字节不变；截断内容先经 repairTruncatedAppendOnlyContent 在内存里修复，再校验
 * 修复结果。整份日文件只读一遍，只发生在启动、跨日打开，以及追加失败后按
 * LOG_REOPEN_RETRY_MS 退避的那次重试上；追加热路径不调用本函数。
 */
async function inspectLogDay(day: string): Promise<LogDayInspection> {
  const path: string = join(LOGS_DIR, `${day}.json`);
  const inspection: RepairableAppendOnlyInspection<void> | null = await inspectRepairableAppendOnlyFile(
    path,
    (parsed: unknown): void => assertLogFileSchema(path, parsed)
  );
  if (inspection === null) {
    return {
      path,
      rewriteContent: null,
      state: { day, size: 0, empty: true },
    };
  }
  return {
    path,
    rewriteContent: inspection.rewriteContent,
    state: { day, size: inspection.state.size, empty: inspection.state.empty },
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

/**
 * 清掉 LOGS_DIR 下残留的 *.tmp：日文件首条写入（appendOnlyDayFile.ts 的
 * appendToAppendOnlyFile）、尾部修复与排版规范化（adoptLogDay，以及追加失败且原位
 * 回滚也失败后 openAppendOnlyFile 重新探测）都经 atomicWriteTextSync 走 tmp + rename，正常情况
 * rename 后 tmp 不会留下；只有
 * 进程恰好在 writeFileSync 与 renameSync 之间被杀、或 rename 本身失败（磁盘
 * 满等）才会留下孤儿文件。DAY_FILE_PATTERN 只匹配 <day>.json，不匹配
 * <day>.json.tmp，保留期清理天然覆盖不到，得单独扫一遍删掉——对齐
 * snapshotFiles.ts 的 maintainLuckDay 同样的清理。
 */
function cleanupStaleTmpFiles(names: readonly string[] = readdirSync(LOGS_DIR)): Promise<void> {
  return removeOrphanedTempFiles(LOGS_DIR, names);
}

/** 删除超出保留期的日志文件（保留今天在内的最近 RETENTION_DAYS 天）。 */
async function cleanupOldLogs(names: readonly string[] = readdirSync(LOGS_DIR)): Promise<void> {
  const oldestKept: string = shiftDateKey(getDateKey(), 1 - RETENTION_DAYS);
  for (const name of names) {
    const match: RegExpExecArray | null = DAY_FILE_PATTERN.exec(name);
    // 删除失败不影响写入，下次跨天再试。
    if (match && match[1]! < oldestKept) await bestEffortUnlink(join(LOGS_DIR, name));
  }
}

async function writeDay(day: string, texts: string[]): Promise<boolean> {
  if (texts.length === 0) return true;
  const now: number = Date.now();
  // 上一次追加失败后还在退避窗口内：直接丢这一批，不重走 openLogDay。磁盘满、
  // 卷转只读这类故障不会在一个 flush 周期内自愈，而重开一次要把整个日文件读一
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
  const names: string[] = listOptionalDirectory(LOGS_DIR);
  return { names, day: await inspectLogDay(getDateKey()) };
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

/** 立即把内存 buffer 落盘（诊断批尾、每日维护或统一 flush 指令触发时调用）。 */
export async function flushLogBuffer(): Promise<boolean> {
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

/**
 * 处理一条日志消息：只入内存 buffer。调用方（diskIOWorker.ts 的诊断批）消费完整批后
 * 必定调用 flushLogBuffer，因此 buffer 不跨批累积，也不需要阈值或定时落盘。
 */
export function handleLogMessage(msg: LogEnvelope): void {
  // message 只拼字符串参数；存在非字符串参数（展开后的 Error 对象等）时，完整
  // 参数列表只写进 args。全是字符串参数时 args 为 undefined，落盘时省略。
  const stringArgs: string[] = [];
  let hasStructuredArgs: boolean = false;
  for (const arg of msg.args) {
    if (typeof arg === "string") stringArgs.push(arg);
    else hasStructuredArgs = true;
  }
  const record: LogRecord = {
    level: msg.level,
    message: stringArgs.join(" "),
    args: hasStructuredArgs ? msg.args : undefined,
  };
  // key 以配置时区的日期时间为前缀，主线程入队时生成的 id 区分重复本地时间与同一
  // 毫秒内的日志，整批重投时保持不变。
  markLogDirty({
    day: getDateKey(msg.timestamp),
    text: serializeDayFileEntry(`${formatLogTimestamp(msg.timestamp)}_${msg.id}`, record),
  });
}
