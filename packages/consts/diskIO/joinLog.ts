/**
 * 入群日志的格式与生命周期常量。消费方是 packages/workers/diskIO/joinLogWrites.ts
 * （接管与写入）、joinLogFiles.ts（路由与读取）与 joinLogRecovery.ts（启动恢复）。
 */

/**
 * 按群、按东京日期命名的入群日志文件。
 * 捕获组 1 是群 ID，捕获组 2 是 YYYY-MM-DD 日期。
 */
export const JOIN_LOG_FILE_PATTERN: RegExp =
  /^(-?[1-9]\d*)\.(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * 入群日志追加失败后的重开退避。与普通日志使用同一批量窗口数量级，
 * 避免磁盘故障时每条入群事件都完整重读并校验日文件。
 */
export const JOIN_LOG_REOPEN_RETRY_MS: number = 5 * 60_000;

/**
 * 入群文件保留的东京自然日数。滚动窗口最多 24 小时，本来只需今天与昨天；
 * 第三天专门覆盖 23:59 发起、跨过午夜才进入 Worker 的在途查询。
 */
export const JOIN_LOG_FILE_RETENTION_DAYS: number = 3;

/**
 * 允许补记的事件日期数：当前东京日与上一东京日。更旧事件已不可能进入最长
 * 24 小时查询窗口，重投也不应重新制造历史文件。
 */
export const JOIN_LOG_ACCEPTED_EVENT_DAYS: number = 2;

/** 单个群日最多保留的不同成员数；超过时保留 joinedAt 最新的记录。 */
export const JOIN_LOG_MAX_USERS_PER_CHAT_DAY: number = 250_000;

/**
 * Disk I/O Worker 内最多常驻的群日索引数。运维基线约 15 个活跃群、每群保留
 * 3 日，64 可覆盖常态 45 份索引并留出跨日查询余量；超出后按 LRU 丢弃可从
 * 磁盘重建的索引，不改变权威文件。
 */
export const JOIN_LOG_MAX_CACHED_FILES: number = 64;

/**
 * 磁盘失败退避表的独立上限。淘汰最旧项只会让该文件下一次提前重试，不会
 * 跳过落盘或确认尚未持久化的 update。
 */
export const JOIN_LOG_MAX_RETRY_FILES: number = 128;

/**
 * 失败后仍可留在 Worker 内存中的最大待刷事实数，共四个 300 条落盘批次。
 * 达到上限后快速失败，由主线程拒绝 durability barrier 并保留 update 重投。
 */
export const JOIN_LOG_MAX_BUFFERED_ENTRIES: number = 1_200;

/** 已确认冗余历史达到该条数时评估一次原子压缩。 */
export const JOIN_LOG_COMPACT_REDUNDANT_ENTRIES: number = 10_000;

/** 自上次评估后新增物理字节达到该值时评估一次原子压缩。 */
export const JOIN_LOG_COMPACT_CHECK_BYTES: number = 4 * 1_024 * 1_024;

/** 只有预计至少能回收这么多物理字节才执行整文件原子重写。 */
export const JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES: number = 512 * 1_024;

/**
 * 全量快照原子写的目标分块大小；单块可能因一条 JSON 记录略微超过该值，
 * 但不会随 25 万条容量线性增长。
 */
export const JOIN_LOG_SNAPSHOT_CHUNK_BYTES: number = 256 * 1_024;

/**
 * 空快照文本 `{}` 的 UTF-8 字节数。
 *
 * 下面三条与 workers/diskIO/joinLogRecords.ts 的序列化格式一一对应：快照容量
 * 记账走的是按记录的循环，对这些固定字面量重复调用 `Buffer.byteLength` 属于
 * 每条记录付一次的常量开销。改动序列化格式时必须同批更新这三条；
 * test/workers/diskIO/joinLogFiles.test.ts 用真实序列化结果的
 * `Buffer.byteLength` 与 measureJoinLogSnapshotBytes 对拍锁住它们。
 */
export const JOIN_LOG_EMPTY_SNAPSHOT_BYTES: number = 2;

/** 非空快照外框 `{\n` 与 `\n}` 中任意一半的 UTF-8 字节数。 */
export const JOIN_LOG_SNAPSHOT_BRACE_BYTES: number = 2;

/** 快照中相邻两条记录之间分隔符 `,\n` 的 UTF-8 字节数。 */
export const JOIN_LOG_ENTRY_SEPARATOR_BYTES: number = 2;
