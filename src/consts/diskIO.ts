/**
 * 磁盘 IO 线程（src/workers/diskIOWorker.ts）的调参常量：日志、AI/贴纸快照、
 * 每日运势与待验证增量共用同一个 Worker。目录路径见 paths.ts。
 */

// ---- 日志（原 consts/logger.ts，数值原样保留，行为零变化） ----

/** 仅保留最近几天（今天及之前）的日志文件，跨天时自动清理过期文件。 */
export const RETENTION_DAYS: number = 3;

/** 日志文件名形态（YYYY-MM-DD.json），清理过期文件时用它识别并提取日期；
 *  运势文件同样按东京日期命名，复用同一个模式（见 workers/diskIO/snapshotFiles.ts）。 */
export const DAY_FILE_PATTERN: RegExp = /^(\d{4}-\d{2}-\d{2})\.json$/;

// ---- 日志 / 每日运势共用的追加窗口 ----
// 两者落盘都是"按位置追加"（见 workers/diskIO/appendOnlyDayFile.ts）：entries
// 只增不改，条数不像 AI 记忆快照那样有固定上限，值得按条数或时间双阈值
// 分批落盘，不必每来一条就单独触发一次追加。内存 buffer 攒满
// FLUSH_MAX_ENTRIES 条、或距首条入队 FLUSH_INTERVAL_MS 时批量落盘，两个
// 域各自独立计数/计时（缓冲区、定时器互不共享），只是复用同一组阈值。

export const FLUSH_MAX_ENTRIES: number = 300;
export const FLUSH_INTERVAL_MS: number = 30_000;

// ---- AI 记忆快照 ----

/** AI 记忆快照文件名形态（<chatId>.json，chatId 为整数，可为负）。 */
export const AI_MEMORY_FILE_PATTERN: RegExp = /^(-?\d+)\.json$/;

// ---- 贴纸目录 ----
// 落盘/恢复机制与 AI 记忆快照完全一致（整份覆盖写 + tmp/rename 原子性），
// 共用同一条定时落盘窗口（SNAPSHOT_FLUSH_INTERVAL_MS），见
// workers/diskIOWorker.ts 的 flushSnapshots。

/** 贴纸目录文件名形态（<pack>.json，pack 是贴纸集合的 short name）。 */
export const STICKER_CATALOG_FILE_PATTERN: RegExp = /^(.+)\.json$/;

/**
 * 按天文件（workers/diskIO/appendOnlyDayFile.ts）序列化时统一使用的 JSON
 * 缩进宽度。三处强耦合，必须永远一致：openDayFile 的维护性整份重写、
 * serializeDayFileEntry 的单条目序列化、repairTruncated 按这个缩进宽度
 * 识别"一条完整记录的收尾行"。单独改其中一处会让 repairTruncated 的行
 * 边界识别失效——断电截断的场景会从"能修复"静默退化成"直接放弃、从空
 * 文件重开"，扩大数据丢失范围。
 */
export const DAY_FILE_JSON_INDENT: number = 2;

/**
 * dirty 群的 AI 记忆快照，定时批量落盘的间隔。没有条数阈值——快照本身已在
 * aiChatWorker 侧按 AI_SNAPSHOT_INTERVAL_MS 节流（见 consts/aiChat.ts），
 * 到这里频率天然有界，且整份覆盖写的开销不随条数增长（快照有固定上限，
 * 见 snapshotFiles.ts 模块头注释），不需要额外的条数阈值。运势不共用
 * 这一条——它用的是跟日志一样的 FLUSH_MAX_ENTRIES/FLUSH_INTERVAL_MS 窗口。
 */
export const SNAPSHOT_FLUSH_INTERVAL_MS: number = 10_000;

// ---- Anti-Raid 待验证增量 JSON ----

/** 普通消息 ID/提醒回填变化的短合并窗口；创建与终结立即追加。 */
export const VERIFICATION_FLUSH_INTERVAL_MS: number = 250;
export const VERIFICATION_FLUSH_MAX_KEYS: number = 100;
/** 重复历史达到任一阈值前收敛为 active 快照，避免当天文件无限增长。 */
export const VERIFICATION_FILE_COMPACT_ENTRIES: number = 10_000;
export const VERIFICATION_FILE_COMPACT_BYTES: number = 4 * 1024 * 1024;
/** 读取损坏/手工修改文件时的防御上限；运行时消息窗口会另设更小上限。 */
export const VERIFICATION_FILE_MAX_MESSAGE_IDS: number = 5_000;

// ---- 启动 load 握手 ----

/** 主线程等待 diskIOWorker 完成启动恢复（load）的超时；超时拒绝启动，避免用空状态覆盖旧持久化数据。 */
export const LOAD_TIMEOUT_MS: number = 5_000;
