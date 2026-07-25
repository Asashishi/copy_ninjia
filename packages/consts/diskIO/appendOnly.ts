/** 日志与每日运势按日追加文件的格式和批量落盘窗口。 */

/** 仅保留最近几天（今天及之前）的日志文件，跨天时自动清理过期文件。 */
export const RETENTION_DAYS: number = 3;
/** 日志与运势文件名形态（YYYY-MM-DD.json）。 */
export const DAY_FILE_PATTERN: RegExp = /^(\d{4}-\d{2}-\d{2})\.json$/;
/** 每个领域达到条数或时间阈值时批量追加；缓冲区和计时器互不共享。 */
export const FLUSH_MAX_ENTRIES: number = 300;
/** 日志与运势增量没有达到条数阈值时的最长驻留时间。 */
export const FLUSH_INTERVAL_MS: number = 30_000;
/** appendOnlyDayFile 序列化与截断修复共同使用的 JSON 缩进宽度。 */
export const DAY_FILE_JSON_INDENT: number = 2;
