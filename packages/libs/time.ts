import { DAY_MS } from "../consts/diskIO/common";
import { TOKYO_UTC_OFFSET_MS } from "../consts/time";

/**
 * 把毫秒数格式化成中文时长文案，如 90_000 -> "1分30秒"，30_000 -> "30秒"。
 * 秒数向上取整：调用方多是「还要等多久」的倒计时/时限文案，宁可报多一点，
 * 也不要在还剩几百毫秒时报出「0秒」。整千毫秒的常量不受影响。
 */
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
 * 非负 epoch 毫秒对应的东京自然日序号；用于每消息日期比较，不分配 Date 或进入 ICU。
 * 商与余数分开偏移，避免接近安全整数上限时直接相加溢出。
 */
export function getTokyoDayIndex(timestampMs: number): number {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new RangeError("Tokyo day timestamp must be a non-negative safe integer.");
  }
  const wholeDays: number = Math.floor(timestampMs / DAY_MS);
  const shiftedRemainder: number = timestampMs % DAY_MS + TOKYO_UTC_OFFSET_MS;
  return wholeDays + Math.floor(shiftedRemainder / DAY_MS);
}

/** 时间戳所在东京自然日的 UTC 起点；取余计算避免安全整数上界附近的乘法溢出。 */
export function getTokyoDayStartTimestamp(timestampMs: number): number {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new RangeError("Tokyo day timestamp must be a non-negative safe integer.");
  }
  const shiftedRemainder: number = timestampMs % DAY_MS + TOKYO_UTC_OFFSET_MS;
  return timestampMs - shiftedRemainder % DAY_MS;
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
 * 东京自然日序号（自 1970-01-01 起，1970 之前为负）→ `YYYY{separator}MM{separator}DD`。
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

/** 东京当日已过的秒数 → `HH:mm:ss`。 */
function formatSecondOfDay(secondOfDay: number): string {
  return `${TWO_DIGIT_STRINGS[(secondOfDay / 3_600) | 0]!}:` +
    `${TWO_DIGIT_STRINGS[((secondOfDay / 60) | 0) % 60]!}:${TWO_DIGIT_STRINGS[secondOfDay % 60]!}`;
}

/*
 * 本文件的东京日历函数统一按固定 UTC+9 算术产出，不走 Intl，也不建 Date。
 * 成立的前提是只格式化本进程当下附近的时刻：日本 1948-1951 实行过夏令时，那段时间
 * 算术结果比 Intl 早一小时（1950-07-01 03:00 UTC：Intl 给 13:00、算术给 12:00）。
 * 全部调用点传的都是 `Date.now()` 派生值；格式化用户提供的历史时间必须改用 Intl。
 * `test/libs/time.test.ts` 用 Intl 参照实现逐字符对拍 1970-2100 的采样与边界。
 */

/**
 * 毫秒时间戳（缺省当前时刻）对应的东京日期串（YYYY-MM-DD）。
 * 日志、入群日志、运势、广告样本与验证恢复的按天分文件共用这一个日期划分。
 */
export function getTokyoDateKey(timestampMs: number = Date.now()): string {
  return formatCivilDate(Math.floor((timestampMs + TOKYO_UTC_OFFSET_MS) / DAY_MS), "-");
}

/**
 * 毫秒时间戳 → 东京时区的「2026/07/16 21:35:04」。AI 对话缓存条目
 * （BufferedMessage.at）在记录时格式化一次、直接以此形态落盘/入转录行，
 * 每条进滚动记忆的群消息调用一次（workers/aiChat/bufferedMessage.ts）。
 */
export function formatTokyoTime(timestampMs: number): string {
  const shifted: number = timestampMs + TOKYO_UTC_OFFSET_MS;
  // Math.floor 对 1970 前的负值同样向下取整，余数恒落在 [0, DAY_MS)。
  const days: number = Math.floor(shifted / DAY_MS);
  const secondOfDay: number = ((shifted - days * DAY_MS) / 1_000) | 0;
  // 与 formatCivilDate 同一算法，在本函数内展开，整串只做一次拼接。
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
  return `${year}/${TWO_DIGIT_STRINGS[month]!}/` +
    `${TWO_DIGIT_STRINGS[day]!} ${TWO_DIGIT_STRINGS[(secondOfDay / 3_600) | 0]!}:` +
    `${TWO_DIGIT_STRINGS[((secondOfDay / 60) | 0) % 60]!}:${TWO_DIGIT_STRINGS[secondOfDay % 60]!}`;
}

/**
 * 毫秒时间戳 → 东京时区的「2026-07-16 21:35:04.123」。落盘日志条目的 key 前缀，
 * 每条日志调用一次（workers/diskIO/logFiles.ts）。
 */
export function formatTokyoLogTimestamp(timestampMs: number): string {
  const shifted: number = timestampMs + TOKYO_UTC_OFFSET_MS;
  const days: number = Math.floor(shifted / DAY_MS);
  const millisecondOfDay: number = shifted - days * DAY_MS;
  const millisecond: number = millisecondOfDay % 1_000;
  const millisecondText: string = millisecond < 10
    ? `00${millisecond}`
    : millisecond < 100 ? `0${millisecond}` : `${millisecond}`;
  return `${formatCivilDate(days, "-")} ` +
    `${formatSecondOfDay((millisecondOfDay / 1_000) | 0)}.${millisecondText}`;
}

/**
 * 东京时区的小时数（0~23），心情系统按时段分档用（见 aiChat/ai/mood.ts）。
 * timestampMs 缺省取当前时刻；1970 之前的负值取余为负，加一轮 24 归一。
 */
export function getTokyoHour(timestampMs: number = Date.now()): number {
  const hour: number = Math.floor((timestampMs + TOKYO_UTC_OFFSET_MS) / 3_600_000) % 24;
  return hour < 0 ? hour + 24 : hour;
}

export interface CurrentTimeResult {
  iso: string;
  timezone: string;
  formatted: string;
}

/** getCurrentTime 的格式器：模块加载时构造一次，每次模型请求复用；
 *  长格式带星期等本地化词汇，由 Intl 产出。 */
const TOKYO_FULL_TIME_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo",
  dateStyle: "full",
  timeStyle: "medium",
});

/**
 * 获取当前时间。统一用东京时区（UTC+9），与天气工具及群里日常报时口径
 * 保持一致。不是 function calling 工具——当前时间恒定拼进每次模型请求，
 * 模型不需要自己判断要不要查。两条链路经 workers/aiChat/timeSentence.ts
 * 共用同一句措辞，但**落点不同**：
 *
 * - 回复链路拼进 **user 内容**的运行时状态区块（workers/aiChat/runtimeState.ts
 *   的 buildRuntimeStateBlock）。**不得挪回 systemInstruction**：那一段连同
 *   人设与工具声明必须逐字恒定，掺进一个精确到秒的串就等于让稳定前缀每秒
 *   换一次指纹，两家供应商的自动前缀缓存从此全程落空（见
 *   workers/aiChat/replyModel.ts 的头注与 runtimeState.ts 的模块注释）。
 * - 冷历史压缩拼进 **userContent 末尾**、整批转录之后（workers/aiChat/compaction.ts
 *   的 summarizeBatch）。那条路的 systemPrompt 是逐字恒定的 SUMMARY_SYSTEM_PROMPT，
 *   也是该请求唯一可被隐式缓存的前缀段，同样不得掺进这个精确到秒的串。
 */
export function getCurrentTime(): CurrentTimeResult {
  const now: Date = new Date();
  return {
    iso: now.toISOString(),
    timezone: "Asia/Tokyo",
    formatted: TOKYO_FULL_TIME_FORMATTER.format(now),
  };
}
