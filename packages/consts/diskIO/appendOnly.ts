/** 按日追加文件的格式，以及各持久化领域共用的批量落盘窗口。 */

/** 仅保留最近几天（今天及之前）的日志文件，跨天时自动清理过期文件。 */
export const RETENTION_DAYS: number = 3;
/** 日志与运势文件名形态（YYYY-MM-DD.json）。 */
export const DAY_FILE_PATTERN: RegExp = /^(\d{4}-\d{2}-\d{2})\.json$/;
/** 批量落盘的累计变更阈值；各领域独立计数并调度。 */
export const FLUSH_MAX_ENTRIES: number = 300;
/** 批量落盘的时间阈值；从首条变更计时，未达累计阈值时到期触发。 */
export const FLUSH_INTERVAL_MS: number = 30_000;
/** appendOnlyDayFile 序列化与截断修复共同使用的 JSON 缩进宽度。 */
export const DAY_FILE_JSON_INDENT: number = 2;

/**
 * 日志追加失败之后重新打开日文件的退避间隔（见 workers/diskIO/logFiles.ts 的
 * writeDay）。追加失败会丢弃当前游标，让下一次 flush 重新校验文件，避免在
 * 损坏的结尾上继续追加；重开一次需要整份读回、解析并校验日文件，因此以退避
 * 限制重试频率。这条线程同时持有身份策略/群状态 SQLite、移除 outbox 与 AI
 * 记忆快照，日志故障不应拖垮它们。
 */
export const LOG_REOPEN_RETRY_MS: number = FLUSH_INTERVAL_MS * 10;

/**
 * 运势追加连续失败多少次之后，Worker 向主线程发一条 luckAppendStalled 诊断，
 * 由主线程的运势 owner 记进统一 `logs/`（见 workers/diskIO/luckFiles.ts 的
 * flushLuckAppends 与 commands/luckChallenge/cache.ts 的监听）。
 *
 * 本 Worker 自身的写盘错误按设计只有 `console.error`（见 workers/diskIOWorker.ts
 * 模块头），部署方可能不采集这条输出；这条诊断额外给出一条一定能进 `logs/`
 * 的告警，不取代 console.error。追加失败按 FLUSH_INTERVAL_MS 重排重试（见
 * scheduleLuckFlush），达到本阈值约等于持续写入失败 1 分钟。
 */
export const LUCK_APPEND_STALL_ALERT_FAILURES: number = 3;

/**
 * 跨日刷盘失败期间，最多滞留多少条「新一天」的抽签等待补录（见
 * workers/diskIO/luckFiles.ts 的 handleLuckDrawMessage）。
 *
 * 换日前必须先把旧日已确认结果刷盘，刷不动就不能换 owner（startLuckDay
 * 会把待刷批次整个清零）；触发换日的那条新日抽签已写入主线程 dailyLuckCache
 * 并回执用户，须滞留补录，否则磁盘恢复后当天文件永久缺失这一条。超出上限后
 * 丢弃最旧的一条并记一行日志，不静默丢失。
 */
export const LUCK_DEFERRED_DRAW_MAX: number = FLUSH_MAX_ENTRIES;
