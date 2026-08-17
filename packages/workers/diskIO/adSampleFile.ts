/**
 * 广告判定命中样本的旁路落盘：memory/ad-detected/sample.json，顶层 JSON 对象
 * `{ "<chatId>:<首条 messageId>": { detectedAt, ... }, ... }`，复用
 * appendOnlyDayFile.ts 的按位置追加（只覆写结尾的「\n}」）。
 *
 * **这是整个持久化里唯一只写不读的一类**，三条由此而来的取舍：
 * - **进程从不读它**。启动恢复不碰，Worker 重建不 hydrate，也没有任何内存镜像
 *   ——它不是运行时状态，是给人看的原始素材，用来回头调 config/ad_samples.json
 *   的判定口径。少一条、多一条、甚至整个文件被删都不影响机器人的任何行为。
 * - **不进统一 flush 的领域清单**。收到即写、失败即弃（只 console.error）。列进去
 *   的话，一个纯诊断文件的写盘失败会让 `/block` 的落盘确认报失败，把运维引向
 *   一个其实没坏的东西；而这份样本本来就允许丢。
 * - **允许截断自愈**（repair=true）。断电撕裂了末尾那条就裁掉，同日志/运势的
 *   取舍；这里连「丢掉最后几条」都不构成正确性问题。
 *
 * 攒太多时按 AD_SAMPLE_FILE_MAX_BYTES 轮转成带日期的归档；归档按文件名中的
 * 东京日期保留最近 AD_SAMPLE_ARCHIVE_RETENTION_DAYS 个自然日。轮转是为了读回
 * 成本：追加游标在 Worker 重建后与每次追加失败后都作废，下一条命中要对整份
 * 文件重跑一次同步读 + parse，压在唯一那条串行 I/O 线程上。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import type { AdSampleDiskMessage } from "../../types/diskIO";
import type { AppendOnlyFileState } from "../../types/diskIO/storage";
import { AD_SAMPLE_FILE_PATH, AD_SAMPLE_MEMORY_DIR, TMP_FILE_SUFFIX } from "../../consts/paths";
import {
  AD_SAMPLE_ARCHIVE_FILENAME_PATTERN,
  AD_SAMPLE_ARCHIVE_RETENTION_DAYS,
  AD_SAMPLE_FILE_MAX_BYTES,
  DAY_MS,
  PERSISTED_FILE_MODE,
} from "../../consts/diskIO/common";
import {
  adSampleArchiveCursor,
  adSampleArchiveSweepDay,
  adSampleFileState,
  adSampleTempsSwept,
} from "../../cache/workers/diskIO/adSample";
import { getTokyoDateKey } from "../../libs/time";
import { appendToAppendOnlyFile, openAppendOnlyFile, serializeDayFileEntry } from "./appendOnlyDayFile";

/**
 * 一条样本的落地形态。刻意不放 senderId 以外的身份字段之外的东西——这份文件
 * 是要给人逐条读的，字段越少越好读。
 */
interface AdSampleRecord {
  detectedAt: string;
  chatId: number;
  senderId: number;
  label: string;
  reason: string;
  messages: AdSampleDiskMessage["messages"];
}

interface AdSampleArchiveTarget {
  readonly day: string;
  readonly index: number;
  readonly path: string;
}

export interface AdSampleArchiveEntry {
  name: string;
  isFile: boolean;
}

export interface SweepExpiredAdSampleArchivesParams {
  today: string;
  listEntries?: () => AdSampleArchiveEntry[];
  removeFile?: (path: string) => void;
}

/**
 * 样本在顶层对象里的键：`<chatId>:<本次判定第一条消息的 messageId>`。
 *
 * message_id 在一个群里不会重复，因此这个键天然唯一，且能直接对回 Telegram
 * 里的那条消息。用时间戳当键则会在同一秒的两次命中上撞车。
 */
function sampleKey(msg: AdSampleDiskMessage): string {
  return `${msg.chatId}:${msg.messages[0]?.messageId ?? 0}`;
}

/**
 * 清掉这个目录里的孤儿 .tmp。原子写在 openSync 与 renameSync 之间被硬杀就会留
 * 一个残片，模块自身的 catch 只覆盖进程内错误。其余落盘领域都在启动恢复时扫
 * 自己的目录，本领域按设计没有恢复钩子（进程从不读样本文件），因此挂在第一次
 * 写入前、每个 isolate 只做一次——不扫的话没有任何代码路径能删掉它们。
 */
function sweepOrphanedTemps(): void {
  if (adSampleTempsSwept.current) return;
  adSampleTempsSwept.current = true;
  const prefix: string = `.${basename(AD_SAMPLE_FILE_PATH)}.`;
  try {
    for (const name of readdirSync(AD_SAMPLE_MEMORY_DIR)) {
      if (!name.startsWith(prefix) || !name.endsWith(TMP_FILE_SUFFIX)) continue;
      try {
        unlinkSync(join(AD_SAMPLE_MEMORY_DIR, name));
      } catch (error: unknown) {
        console.error(`[diskIOWorker] failed to remove orphaned ad sample temp ${name}:`, error);
      }
    }
  } catch (error: unknown) {
    console.error("[diskIOWorker] failed to sweep orphaned ad sample temps:", error);
  }
}

/** 列出目录项并保留“普通文件”信息；符号链接和目录都不能进入归档删除路径。 */
function listAdSampleArchiveEntries(): AdSampleArchiveEntry[] {
  return readdirSync(AD_SAMPLE_MEMORY_DIR, { withFileTypes: true }).map(
    (entry: Dirent<string>): AdSampleArchiveEntry => ({
      name: entry.name,
      isFile: entry.isFile(),
    })
  );
}

/** 解析严格归档名中的有效公历日期；未知格式和不存在的日期都返回 null。 */
function archiveDayFromName(name: string): string | null {
  const matched: RegExpExecArray | null = AD_SAMPLE_ARCHIVE_FILENAME_PATTERN.exec(name);
  const day: string | undefined = matched?.[1];
  if (day === undefined) return null;
  const parsed: Date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null;
  return day;
}

/** 今天在内最近 N 个自然日的首日；东京没有夏令时，按固定 DAY_MS 回退安全。 */
function earliestRetainedArchiveDay(today: string): string {
  const todayMs: number = Date.parse(`${today}T00:00:00.000Z`);
  return new Date(
    todayMs - (AD_SAMPLE_ARCHIVE_RETENTION_DAYS - 1) * DAY_MS
  ).toISOString().slice(0, 10);
}

/**
 * 按归档名里的东京日期清理过期普通文件。清扫和单文件删除都 best effort；
 * 日期先记账，保证失败不会让后续每条样本反复扫描目录。
 */
export function sweepExpiredAdSampleArchives({
  today,
  listEntries = listAdSampleArchiveEntries,
  removeFile = unlinkSync,
}: SweepExpiredAdSampleArchivesParams): void {
  const previousDay: string | null = adSampleArchiveSweepDay.current;
  if (previousDay !== null && today <= previousDay) return;
  adSampleArchiveSweepDay.current = today;
  const earliestRetainedDay: string = earliestRetainedArchiveDay(today);
  let entries: AdSampleArchiveEntry[];
  try {
    entries = listEntries();
  } catch (error: unknown) {
    console.error("[diskIOWorker] failed to sweep expired ad sample archives:", error);
    return;
  }
  let occupiedTodayIndexes: Set<number> | null = null;
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const archiveDay: string | null = archiveDayFromName(entry.name);
    if (archiveDay === today) {
      const match: RegExpExecArray | null = AD_SAMPLE_ARCHIVE_FILENAME_PATTERN.exec(entry.name);
      const suffix: string | undefined = match?.[2];
      const index: number = suffix === undefined ? 1 : Number(suffix);
      // `.1` 不是选名器会生成的候选；它不能占用无序号的 index=1。
      if (suffix === undefined || (index >= 2 && Number.isSafeInteger(index))) {
        occupiedTodayIndexes ??= new Set<number>();
        occupiedTodayIndexes.add(index);
      }
    }
    if (archiveDay === null || archiveDay >= earliestRetainedDay) continue;
    try {
      removeFile(join(AD_SAMPLE_MEMORY_DIR, entry.name));
    } catch (error: unknown) {
      console.error(
        `[diskIOWorker] failed to remove expired ad sample archive ${entry.name}:`,
        error
      );
    }
  }
  if (occupiedTodayIndexes === null) {
    adSampleArchiveCursor.current = null;
  } else {
    let nextIndex: number = 1;
    while (occupiedTodayIndexes.has(nextIndex)) nextIndex++;
    adSampleArchiveCursor.current = { day: today, nextIndex };
  }
}

/**
 * 给这次轮转挑一个没被占用的归档名：`sample.<东京日期>.json`，同一天再轮转
 * 就往后加序号；保留期清理由 sweepExpiredAdSampleArchives 独立负责。
 */
function nextArchiveTarget(): AdSampleArchiveTarget {
  const day: string = getTokyoDateKey();
  const base: string = join(AD_SAMPLE_MEMORY_DIR, `sample.${day}`);
  let index: number = adSampleArchiveCursor.current?.day === day
    ? adSampleArchiveCursor.current.nextIndex
    : 1;
  while (true) {
    const candidate: string = index === 1
      ? `${base}.json`
      : `${base}.${index}.json`;
    if (!existsSync(candidate)) {
      return { day, index, path: candidate };
    }
    index++;
  }
}

/**
 * 文件涨过上限就整份改名归档，让下一条样本从空文件写起。
 * @returns 轮转后应当使用的游标；没到上限时原样返回传入的游标。
 */
function rotateIfOversized(state: AppendOnlyFileState): AppendOnlyFileState {
  if (state.size < AD_SAMPLE_FILE_MAX_BYTES) return state;
  const archive: AdSampleArchiveTarget = nextArchiveTarget();
  renameSync(AD_SAMPLE_FILE_PATH, archive.path);
  // 只有 rename 成功才推进；失败时下轮仍复用同一个最小空缺，保持既有选名语义。
  adSampleArchiveCursor.current = { day: archive.day, nextIndex: archive.index + 1 };
  console.error(
    `[diskIOWorker] ad sample file reached ${state.size} bytes; archived it as ${basename(archive.path)}.`
  );
  return { size: 0, empty: true };
}

/**
 * 追加一条命中样本。失败只 console.error 并作废游标，不重试、不缓冲、不上报
 * ——调用方（diskIOWorker 的消息路由）也不看返回值。
 */
export function handleAdSampleMessage(msg: AdSampleDiskMessage): void {
  const record: AdSampleRecord = {
    detectedAt: msg.detectedAt,
    chatId: msg.chatId,
    senderId: msg.senderId,
    label: msg.label,
    reason: msg.reason,
    messages: msg.messages,
  };
  try {
    // 目录在这里按需建：本文件没有启动恢复阶段可以顺带建目录，而首次命中
    // 可能发生在部署后的任何时候。recursive 让它幂等。
    mkdirSync(AD_SAMPLE_MEMORY_DIR, { recursive: true });
    sweepOrphanedTemps();
    sweepExpiredAdSampleArchives({ today: getTokyoDateKey() });
    adSampleFileState.current ??= openAppendOnlyFile(
      AD_SAMPLE_FILE_PATH,
      PERSISTED_FILE_MODE,
      true
    );
    // 每次追加前都判一次：游标一旦缓存下来就一直用下去，只在打开时判的话，
    // 一个长期不重启的进程永远轮转不了。
    adSampleFileState.current = rotateIfOversized(adSampleFileState.current);
    const state: AppendOnlyFileState = adSampleFileState.current;
    appendToAppendOnlyFile({
      path: AD_SAMPLE_FILE_PATH,
      state,
      chunk: serializeDayFileEntry(sampleKey(msg), record),
      mode: PERSISTED_FILE_MODE,
      repair: true,
    });
  } catch (error: unknown) {
    // 游标作废：可能已经有前缀落盘，旧位置不再可信，下次写入前重新探测。
    adSampleFileState.current = null;
    console.error("[diskIOWorker] failed to append an ad detection sample:", error);
  }
}
