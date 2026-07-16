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

/**
 * 毫秒时间戳（缺省当前时刻）对应的东京时区日期串（YYYY-MM-DD）。
 * /luck_challenge 的每日缓存与 diskIOWorker 的运势落盘（按东京日期分文件）
 * 共用同一个日期划分，见 commands/luckChallenge.ts、workers/diskIOWorker.ts。
 */
export function getTokyoDateKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
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
