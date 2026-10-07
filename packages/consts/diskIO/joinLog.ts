/**
 * 入群日志的格式与生命周期常量。消费方是 packages/workers/diskIO/joinLogWrites.ts
 * （接管与写入）、joinLogFiles.ts（路由与读取）、joinLogRecovery.ts（启动恢复）、
 * joinLogRecords.ts（快照分块与字节记账）、cache/workers/diskIO/joinLog.ts，以及主线程
 * infra/joinLog.ts（未确认镜像）与 cache/main/joinLog.ts。
 */

import { FLUSH_MAX_ENTRIES } from "./appendOnly";

/**
 * 按群、按配置时区的日期命名的入群日志文件。
 * 捕获组 1 是群 ID，捕获组 2 是 YYYY-MM-DD 日期。
 */
export const JOIN_LOG_FILE_PATTERN: RegExp =
  /^(-?[1-9]\d*)\.(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * 入群日志追加失败后的重开退避；退避期内同一日文件的写入分组被跳过，不重读与校验日文件。
 */
export const JOIN_LOG_REOPEN_RETRY_MS: number = 5 * 60_000;

/**
 * 入群文件至少保留的配置时区自然日数，覆盖前一日命令的滚动窗口；
 * 夏令时短日使窗口跨越更多日期时，由保留边界额外纳入这些日文件。
 */
export const JOIN_LOG_FILE_RETENTION_DAYS: number = 3;

/**
 * 固定接纳的事件日期数：配置时区当天与前一天。更旧日期仅在仍属于滚动
 * 窗口时接纳（覆盖夏令时短日），窗口外的重投不写出日文件。
 */
export const JOIN_LOG_ACCEPTED_EVENT_DAYS: number = 2;

/** 单个群日最多保留的不同成员数；超过时保留 joinedAt 最新的记录。 */
export const JOIN_LOG_MAX_USERS_PER_CHAT_DAY: number = 250_000;

/**
 * Disk I/O Worker 内最多常驻的群日索引数。入群日志只为受管群写入（初始化网关），
 * 常态写入集合覆盖当天与前一天；夏令时短日补记和 `/batch_kick` 跨日查询也会接管
 * 更早的日文件。缓存上限独立于日文件保留窗口。
 * 超出后按 LRU 丢弃可从磁盘重建的索引，不改变权威文件。
 *
 * 内存上界为本上限乘以单份索引满载 JOIN_LOG_MAX_USERS_PER_CHAT_DAY 条时的占用。
 */
export const JOIN_LOG_MAX_CACHED_FILES: number = 64;

/**
 * 磁盘失败退避表的独立上限。淘汰最旧项只会让该文件下一次提前重试，不会
 * 跳过落盘或确认尚未持久化的 update。
 */
export const JOIN_LOG_MAX_RETRY_FILES: number = 128;

/**
 * 主线程未确认落盘的入群事实镜像上限，取 FLUSH_MAX_ENTRIES 的固定倍数；已写入的事实随
 * 处置回执释放，只有尚未落盘的事实占用名额。Disk I/O Worker 的待写集合恒为该镜像的
 * 子集，因此同一上限也约束 Worker 内存。达到上限后 recordJoinLog 快速失败，对应 update
 * 不被确认并由 Telegram 重投。
 * 所属模块：cache/main/joinLog.ts、infra/joinLog.ts。
 */
export const JOIN_LOG_MAX_BUFFERED_ENTRIES: number = FLUSH_MAX_ENTRIES * 4;

/** 已确认冗余历史达到该条数时评估一次原子压缩。 */
export const JOIN_LOG_COMPACT_REDUNDANT_ENTRIES: number = 10_000;

/** 自上次评估后新增物理字节达到该值时评估一次原子压缩。 */
export const JOIN_LOG_COMPACT_CHECK_BYTES: number = 4 * 1_024 * 1_024;

/** 只有预计至少能回收这么多物理字节才执行整文件原子重写。 */
export const JOIN_LOG_COMPACT_MIN_RECLAIM_BYTES: number = 512 * 1_024;

/**
 * 全量快照原子写的目标分块大小；单块可能因一条 JSON 记录略微超过该值，
 * 但不会随 JOIN_LOG_MAX_USERS_PER_CHAT_DAY 容量线性增长。
 */
export const JOIN_LOG_SNAPSHOT_CHUNK_BYTES: number = 256 * 1_024;

/**
 * 空快照文本 `{}` 的 UTF-8 字节数。
 *
 * 本条与下面两条与 workers/diskIO/joinLogRecords.ts 的序列化格式一一对应，
 * 快照容量记账直接使用这三个预算好的字节数。改动序列化格式时必须同批更新这三条；
 * test/workers/diskIO/joinLogFiles.test.ts 用真实序列化结果的
 * `Buffer.byteLength` 与 measureJoinLogSnapshotBytes 对拍锁住它们。
 */
export const JOIN_LOG_EMPTY_SNAPSHOT_BYTES: number = 2;

/** 非空快照外框 `{\n` 与 `\n}` 中任意一半的 UTF-8 字节数。 */
export const JOIN_LOG_SNAPSHOT_BRACE_BYTES: number = 2;

/** 快照中相邻两条记录之间分隔符 `,\n` 的 UTF-8 字节数。 */
export const JOIN_LOG_ENTRY_SEPARATOR_BYTES: number = 2;
