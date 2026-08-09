/** AI 记忆与贴纸目录整份覆盖快照的文件格式和落盘窗口。 */

/** AI 记忆快照文件名形态（<chatId>.json，chatId 为非零整数，可为负）。 */
export const AI_MEMORY_FILE_PATTERN: RegExp = /^(-?\d+)\.json$/;
/** dirty 快照定时批量落盘的间隔。 */
export const SNAPSHOT_FLUSH_INTERVAL_MS: number = 10_000;
