/**
 * 磁盘 IO 线程（src/workers/diskIOWorker.ts）的调参常量：日志、AI 记忆快照、
 * 每日运势快照三类落盘共用同一个 Worker。目录路径见 paths.ts。
 */

// ---- 日志（原 consts/logger.ts，数值原样保留，行为零变化） ----

/** 仅保留最近几天（今天及之前）的日志文件，跨天时自动清理过期文件。 */
export const RETENTION_DAYS: number = 3;

// 内存 buffer 攒满 FLUSH_MAX_ENTRIES 条、或距首条入队 FLUSH_INTERVAL_MS 时批量落盘。
export const FLUSH_MAX_ENTRIES: number = 300;
export const FLUSH_INTERVAL_MS: number = 60_000;

/** 日志文件名形态（YYYY-MM-DD.json），清理过期文件时用它识别并提取日期；
 *  运势文件同样按东京日期命名，复用同一个模式（见 workers/diskIO/snapshotFiles.ts）。 */
export const DAY_FILE_PATTERN: RegExp = /^(\d{4}-\d{2}-\d{2})\.json$/;

// ---- AI 记忆 / 每日运势快照 ----

/** AI 记忆快照文件名形态（<chatId>.json，chatId 为整数，可为负）。 */
export const AI_MEMORY_FILE_PATTERN: RegExp = /^(-?\d+)\.json$/;

/**
 * dirty 群的 AI 记忆快照 / dirty 的运势缓存，定时批量落盘的间隔。没有条数
 * 阈值——快照本身已在 aiChatWorker 侧按 AI_SNAPSHOT_INTERVAL_MS 节流（见
 * consts/aiChat.ts），到这里频率天然有界；运势写入量同样极小（一分钟全局
 * 限 30 次抽签）。
 */
export const SNAPSHOT_FLUSH_INTERVAL_MS: number = 10_000;

// ---- 启动 load 握手 ----

/** 主线程等待 diskIOWorker 完成启动恢复（load）的超时；超时按空数据继续，不拦 bot 启动。 */
export const LOAD_TIMEOUT_MS: number = 5_000;
