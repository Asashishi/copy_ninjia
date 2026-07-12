/** 日志落盘线程（src/workers/loggerWorker.ts）的调参常量。目录路径见 paths.ts 的 LOGS_DIR。 */

/** 仅保留最近几天（今天及之前）的日志文件，跨天时自动清理过期文件。 */
export const RETENTION_DAYS: number = 3;

// 内存 buffer 攒满 FLUSH_MAX_ENTRIES 条、或距首条入队 FLUSH_INTERVAL_MS 时批量落盘。
export const FLUSH_MAX_ENTRIES: number = 300;
export const FLUSH_INTERVAL_MS: number = 60_000;

/** 日志文件名形态（YYYY-MM-DD.json），清理过期文件时用它识别并提取日期。 */
export const DAY_FILE_PATTERN: RegExp = /^(\d{4}-\d{2}-\d{2})\.json$/;
