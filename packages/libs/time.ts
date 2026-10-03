import { DAY_MS } from "../consts/diskIO/common";
import {
  FORMAT_MAX_TIMESTAMP_MS,
  FORMAT_MIN_TIMESTAMP_MS,
  MAX_EPOCH_MILLISECONDS,
} from "../consts/time";
import { getTimeZone, getTimeZoneState } from "../config/time";
import type { CurrentTimeResult, TimeZoneState } from "../types/time";

/** 秒数向上取整的中文时长文案；用于倒计时与时限提示。 */
export function formatMinSec(ms: number): string {
  const totalSeconds: number = Math.ceil(ms / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  if (minutes === 0) return `${seconds}秒`;
  if (seconds === 0) return `${minutes}分钟`;
  return `${minutes}分${seconds}秒`;
}

/** 严格判断 YYYY-MM-DD 是否为可往返的公历日期，拒绝 02-30 等归一化输入。 */
export function isCanonicalDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed: Date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * 毫秒时间戳对应的配置时区日历；时区规则与夏令时由 Bun/JSC 原生 Temporal 处理。
 * 只服务偏移区段未命中时的重建与 getDayStartTimestamp，不在每次日历运算里调用。
 */
function localDateTime(timestampMs: number): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(timestampMs).toZonedDateTimeISO(getTimeZone());
}

/** 按日判定只接受非负、安全整数且处于原生时间 API 有效范围内的 epoch 毫秒。 */
function validateDayTimestamp(timestampMs: number): void {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > MAX_EPOCH_MILLISECONDS) {
    throw new RangeError("Day timestamp must be a non-negative safe integer within the Temporal range.");
  }
}

/** getLocalHour 只做整数运算，接受原生时间 API 范围内的整数 epoch 毫秒（可为负）。 */
function validateCalendarTimestamp(timestampMs: number): void {
  if (!Number.isInteger(timestampMs) || timestampMs < -MAX_EPOCH_MILLISECONDS || timestampMs > MAX_EPOCH_MILLISECONDS) {
    throw new RangeError("Calendar timestamp must be an integer within the Temporal range.");
  }
}

/** 三个文本格式化函数只接受公元 1000–9999 年的整数 epoch 毫秒。 */
function validateFormatTimestamp(timestampMs: number): void {
  if (!Number.isInteger(timestampMs) || timestampMs < FORMAT_MIN_TIMESTAMP_MS || timestampMs > FORMAT_MAX_TIMESTAMP_MS) {
    throw new RangeError("Formatted timestamp must be an integer within years 1000 to 9999.");
  }
}

/**
 * 配置时区在该时刻的 UTC 偏移（毫秒）。偏移在相邻两次时区规则转换之间恒定：命中本线程缓存的
 * 区段时只做两次比较；未命中时由 Temporal 取该时刻的偏移与前后转换点并替换区段。固定偏移时区
 * 的区段无界，夏令时时区的区段以转换点为界，日历运算因此不必逐次进入 Temporal。
 */
function localOffsetMs(timestampMs: number): number {
  const state: TimeZoneState = getTimeZoneState();
  if (timestampMs >= state.offsetStartMs && timestampMs < state.offsetEndMs) return state.offsetMs;
  const local: Temporal.ZonedDateTime = localDateTime(timestampMs);
  const previous: Temporal.ZonedDateTime | null = local.getTimeZoneTransition("previous");
  const next: Temporal.ZonedDateTime | null = local.getTimeZoneTransition("next");
  // previous 是严格早于该时刻的最近转换点；紧随其后的转换点（没有 previous 时取该时区的首个
  // 转换点）若恰好落在该时刻，区段自该时刻起，否则自 previous 起。
  const startedHere: Temporal.ZonedDateTime | null =
    (previous ?? localDateTime(-MAX_EPOCH_MILLISECONDS)).getTimeZoneTransition("next");
  state.offsetMs = local.offsetNanoseconds / 1_000_000;
  state.offsetStartMs = startedHere !== null && startedHere.epochMilliseconds <= timestampMs
    ? startedHere.epochMilliseconds
    : previous === null ? Number.NEGATIVE_INFINITY : previous.epochMilliseconds;
  state.offsetEndMs = next === null ? Number.POSITIVE_INFINITY : next.epochMilliseconds;
  return state.offsetMs;
}

/** 0~99 的两位零填充串定表；只服务本文件的固定宽度时间串，模块加载时建一次。 */
const TWO_DIGIT_STRINGS: readonly string[] = ((): readonly string[] => {
  const table: string[] = new Array<string>(100);
  for (let value: number = 0; value < 100; value += 1) {
    table[value] = value < 10 ? `0${value}` : `${value}`;
  }
  return table;
})();

/**
 * 自 1970-01-01 起的本地日序号（1970 之前为负）→ `YYYY{separator}MM{separator}DD`。
 * Howard Hinnant 的 civil_from_days：纯整数运算，不建 Date 也不进 ICU。以 3 月为年首
 * （shiftedMonth 0=3 月 … 11=2 月），闰日落在年末，月份换回 1~12 时 1、2 月归入下一年。
 * era 与 shiftedDays 在 1970 之前可为负，用 Math.floor；其余商的被除数非负，用 `| 0` 截断。
 */
function formatCivilDate(days: number, separator: string): string {
  const shiftedDays: number = days + 719_468;
  const era: number = Math.floor(shiftedDays / 146_097);
  const dayOfEra: number = shiftedDays - era * 146_097;
  const yearOfEra: number =
    ((dayOfEra - ((dayOfEra / 1_460) | 0) + ((dayOfEra / 36_524) | 0) -
      ((dayOfEra / 146_096) | 0)) / 365) | 0;
  const dayOfYear: number = dayOfEra -
    (365 * yearOfEra + ((yearOfEra / 4) | 0) - ((yearOfEra / 100) | 0));
  const shiftedMonth: number = ((5 * dayOfYear + 2) / 153) | 0;
  const day: number = dayOfYear - (((153 * shiftedMonth + 2) / 5) | 0) + 1;
  const month: number = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year: number = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  // 月、日由上面的算术封在 1~31 内，`!` 只收窄 noUncheckedIndexedAccess 的 undefined。
  return `${year}${separator}${TWO_DIGIT_STRINGS[month]!}${separator}${TWO_DIGIT_STRINGS[day]!}`;
}

/** 当日已过的秒数 → `HH:mm:ss`。 */
function formatSecondOfDay(secondOfDay: number): string {
  return `${TWO_DIGIT_STRINGS[(secondOfDay / 3_600) | 0]!}:` +
    `${TWO_DIGIT_STRINGS[((secondOfDay / 60) | 0) % 60]!}:${TWO_DIGIT_STRINGS[secondOfDay % 60]!}`;
}

/** 配置时区的自然日序号；相邻公历日期相差一，即使两日间实际相差 23 或 25 小时。 */
export function getDayIndex(timestampMs: number): number {
  validateDayTimestamp(timestampMs);
  return Math.floor((timestampMs + localOffsetMs(timestampMs)) / DAY_MS);
}

/** 所在配置时区自然日的首个真实时刻；按时区规则处理零点偏移与夏令时。 */
export function getDayStartTimestamp(timestampMs: number): number {
  validateDayTimestamp(timestampMs);
  return localDateTime(timestampMs).startOfDay().epochMilliseconds;
}

/** 配置时区日期串 YYYY-MM-DD；日志、运势、广告样本与验证恢复共用此日界。 */
export function getDateKey(timestampMs: number = Date.now()): string {
  validateFormatTimestamp(timestampMs);
  return formatCivilDate(Math.floor((timestampMs + localOffsetMs(timestampMs)) / DAY_MS), "-");
}

/** 配置时区的 YYYY/MM/DD HH:mm:ss；记录时格式化，供 AI 转录与持久化条目使用。 */
export function formatLocalTime(timestampMs: number): string {
  validateFormatTimestamp(timestampMs);
  const shifted: number = timestampMs + localOffsetMs(timestampMs);
  const days: number = Math.floor(shifted / DAY_MS);
  return `${formatCivilDate(days, "/")} ${formatSecondOfDay(((shifted - days * DAY_MS) / 1_000) | 0)}`;
}

/** 配置时区的 YYYY-MM-DD HH:mm:ss.SSS；用于落盘日志条目的 key 前缀。 */
export function formatLogTimestamp(timestampMs: number): string {
  validateFormatTimestamp(timestampMs);
  const shifted: number = timestampMs + localOffsetMs(timestampMs);
  const days: number = Math.floor(shifted / DAY_MS);
  const millisecondOfDay: number = shifted - days * DAY_MS;
  const millisecond: number = millisecondOfDay % 1_000;
  const millisecondText: string = millisecond < 10
    ? `00${millisecond}`
    : millisecond < 100 ? `0${millisecond}` : `${millisecond}`;
  return `${formatCivilDate(days, "-")} ${formatSecondOfDay((millisecondOfDay / 1_000) | 0)}.${millisecondText}`;
}

/** 配置时区小时数 0~23；供心情系统按时段分档。 */
export function getLocalHour(timestampMs: number = Date.now()): number {
  validateCalendarTimestamp(timestampMs);
  return Math.floor(((timestampMs + localOffsetMs(timestampMs)) % DAY_MS + DAY_MS) % DAY_MS / 3_600_000);
}

/**
 * 取当前时刻并用本线程配置时区格式化；AI 回复、冷历史压缩与联网检索共用。
 * 动态时间只拼入 user 内容或检索 query；提示词顺序见 docs/cn/04-invariants.md。
 */
export function getCurrentTime(): CurrentTimeResult {
  const now: Date = new Date();
  const state: TimeZoneState = getTimeZoneState();
  return {
    iso: now.toISOString(),
    timezone: state.timeZone,
    formatted: state.fullTimeFormatter.format(now),
  };
}
