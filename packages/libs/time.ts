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

/** getTokyoDateKey 的格式器：模块加载时构造一次复用（Intl.DateTimeFormat
 *  的构造远贵于 format 调用本身，同下方 TOKYO_TIME_FORMATTER 的理由）——
 *  日志落盘按条调用它算文件名日期，不能每条日志都重新构造一个格式器。 */
const TOKYO_DATE_KEY_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * 毫秒时间戳（缺省当前时刻）对应的东京时区日期串（YYYY-MM-DD）。
 * /luck_challenge 的每日缓存与 diskIOWorker 的运势落盘（按东京日期分文件）
 * 共用同一个日期划分，见 commands/luckChallenge/、workers/diskIOWorker.ts。
 */
export function getTokyoDateKey(date: Date = new Date()): string {
  return TOKYO_DATE_KEY_FORMATTER.format(date);
}

/** formatTokyoTime 的格式器：模块加载时构造一次复用（Intl.DateTimeFormat
 *  的构造远贵于 format 调用本身）。 */
const TOKYO_TIME_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * 毫秒时间戳 → 东京时区的「2026/07/16 21:35:04」。AI 对话缓存条目
 * （BufferedMessage.at）在记录时格式化一次、直接以此形态落盘/入转录行，
 * 模型可直接读，之后拼上下文不再有任何格式化开销。
 */
export function formatTokyoTime(timestampMs: number): string {
  return TOKYO_TIME_FORMATTER.format(timestampMs);
}

/** getTokyoHour 的格式器：模块加载时构造一次复用（理由同上）。hourCycle 显式
 *  指定 h23（0~23），避免部分 ICU 实现在 hour12:false 场景下午夜返回 "24"
 *  而不是 "0" 的已知坑。 */
const TOKYO_HOUR_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  hourCycle: "h23",
  hour: "numeric",
});

/**
 * 东京时区的小时数（0~23）。心情系统按时段调整心情抽选概率用（见
 * aiChat/ai/mood.ts），接受可选的 date 参数仅为可测试性，生产调用省略即取当前时刻。
 */
export function getTokyoHour(date: Date = new Date()): number {
  const hourPart: string | undefined = TOKYO_HOUR_FORMATTER.formatToParts(date).find((part: Intl.DateTimeFormatPart): boolean => part.type === "hour")?.value;
  // % 24 兜底：即便某些环境仍返回 "24"，也不会产出越界的小时数。
  return hourPart ? Number(hourPart) % 24 : date.getHours();
}

export interface CurrentTimeResult {
  iso: string;
  timezone: string;
  formatted: string;
}

/** getCurrentTime 的格式器：模块加载时构造一次复用（理由同上）——每次
 *  Gemini 请求拼系统提示词都会调它，构造开销不该按请求付。 */
const TOKYO_FULL_TIME_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo",
  dateStyle: "full",
  timeStyle: "medium",
});

/**
 * 获取当前时间。统一用东京时区（UTC+9），与天气工具及群里日常报时口径
 * 保持一致。不是 function calling 工具——当前时间默认拼进每次 Gemini 请求的
 * 系统提示词（见 workers/aiChat/geminiReply.ts 与 workers/aiChat/compaction.ts），
 * 模型不需要自己判断要不要查。
 */
export function getCurrentTime(): CurrentTimeResult {
  const now: Date = new Date();
  return {
    iso: now.toISOString(),
    timezone: "Asia/Tokyo",
    formatted: TOKYO_FULL_TIME_FORMATTER.format(now),
  };
}
