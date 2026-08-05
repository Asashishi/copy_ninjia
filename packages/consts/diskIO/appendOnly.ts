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

/**
 * 运势追加连续失败多少次之后，Worker 向主线程发一条 luckAppendStalled 诊断，
 * 由主线程的运势 owner 记进统一 `logs/`（见 workers/diskIO/luckFiles.ts 的
 * flushLuckAppends 与 commands/luckChallenge/cache.ts 的监听）。
 *
 * 为什么需要这条旁路：本 Worker 自身的写盘错误按设计只有 `console.error`
 * （见 workers/diskIOWorker.ts 模块头），而部署可以把 Worker 的 stdout/stderr
 * 接到 /dev/null——那种部署上「条目进了主线程 dailyLuckCache、却永远写不进
 * memory/luck/<day>.json」是**完全不可观测**的。这条诊断不取代 console.error，
 * 只是额外给出一条一定能进 `logs/` 的告警。
 *
 * 取 3：追加失败会按 FLUSH_INTERVAL_MS 重排重试（见 scheduleLuckFlush），因此
 * 3 次连续失败≈持续 1 分钟写不进去，足以滤掉单次瞬时抖动，又不会让运维等太久。
 */
export const LUCK_APPEND_STALL_ALERT_FAILURES: number = 3;

/**
 * 跨日刷盘失败期间，最多滞留多少条「新一天」的抽签等待补录（见
 * workers/diskIO/luckFiles.ts 的 handleLuckDrawMessage）。
 *
 * 为什么需要滞留：换日前必须先把旧日已确认结果刷盘，刷不动就不能换 owner
 * （startLuckDay 会把待刷批次整个清零）。但触发这次换日的那条新日抽签，主线程
 * 早已把它写进 dailyLuckCache 并给用户发了回执——直接丢掉的话，磁盘恢复后当天
 * 文件永远缺这一条，用户当天也再抽不了第二次，而没有任何一条路径会补回来：
 * onDiskIORespawn 的全量重放只覆盖 Worker 重建，不覆盖「Worker 活着但写不进盘」。
 *
 * 取 FLUSH_MAX_ENTRIES：与一个批量窗口同量级，够装下一次典型故障期内的新日抽签
 * （运势是每人每天一次的低频写入），又给出明确的内存上界。超出后丢最旧的一条并
 * 记一行——那时故障已经持续到远超告警阈值，丢失必须是**有记录**的，不能静默。
 */
export const LUCK_DEFERRED_DRAW_MAX: number = FLUSH_MAX_ENTRIES;
