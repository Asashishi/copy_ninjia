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

/**
 * 日志追加失败之后重新打开日文件的退避间隔（见 workers/diskIO/logFiles.ts 的
 * writeDay）。
 *
 * 追加失败会丢弃当前游标，让下一次 flush 重新校验文件——不这么做就会在一个
 * 损坏的结尾上继续追加。但重开一次的代价是把整个日文件 readFileSync +
 * JSON.parse 两遍、逐条走一次 schema 校验、再 readdirSync 扫一遍目录，而磁盘满
 * 或卷转只读这类故障不会在一个 flush 周期内自愈：不退避的话每个周期都要按日
 * 文件大小付一次这个代价，而故障期本身还会制造大量 `logger.error` 把
 * FLUSH_MAX_ENTRIES 压得更密。这条线程同时持有 state.json、黑名单、移除 outbox
 * 与 AI 记忆快照，日志写不下去不该把它们一起拖垮。
 *
 * 取 FLUSH_INTERVAL_MS 的十倍：重试够勤（磁盘腾出来后五分钟内恢复），又足够稀
 * 到重开的开销可以忽略。
 */
export const LOG_REOPEN_RETRY_MS: number = FLUSH_INTERVAL_MS * 10;
