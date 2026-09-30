import type { StorageDatabaseDomain } from "../../types/diskIO/replies";

/** Disk I/O 业务传输每批最多处理的消息数；单批确认后才继续投递。 */
export const DISK_BUSINESS_BATCH_MAX_MESSAGES: number = 128;
/** 磁盘通道为恢复标记与最终 flush 预留的控制消息槽位。 */
export const DISK_OPERATION_CONTROL_RESERVE: number = 16;
/**
 * Disk I/O Worker 本地串行队列的最大在途操作数（workers/diskIO/operationQueue.ts）。
 * 来源上界为 5：主线程的业务批与诊断批各至多一批在途（均在处理完才回 ACK）、启动或
 * 重建时的 load、每日维护 cron 的一项，以及本 Worker 全部定时 flush 合并后的一项（见
 * workers/diskIO/timedFlush.ts）。超出即协议违约，拒收后终止本代 Worker。
 */
export const DISK_WORKER_MAX_QUEUED_OPERATIONS: number = 8;

/** Disk I/O 业务传输保留载荷的估算字节上限；覆盖待发送和在途批次。 */
export const DISK_BUSINESS_MAX_RETAINED_BYTES: number = 64 * 1_024 * 1_024;

/** Disk I/O 单批消费确认期限；超时停止接收新业务并通知应用停机。 */
export const DISK_BUSINESS_ACK_TIMEOUT_MS: number = 30_000;

/** Disk I/O 单消息的对象及队列记账成本；字符串另按 UTF-16 字节计费。 */
export const DISK_BUSINESS_MESSAGE_BASE_BYTES: number = 256;

/** 磁盘操作总预算额外保留控制消息开销，业务满额后仍能排入最终 flush。 */
export const DISK_OPERATION_MAX_RETAINED_BYTES: number = DISK_BUSINESS_MAX_RETAINED_BYTES +
  DISK_OPERATION_CONTROL_RESERVE * DISK_BUSINESS_MESSAGE_BASE_BYTES;

/**
 * 共享 SQLite 事务覆盖的七个领域，也是 all/business flush 回报其失败领域的顺序
 * （workers/diskIO/storageDatabase/flush.ts 的 collectStorageDatabaseFailures）。
 */
export const STORAGE_DATABASE_DOMAINS: readonly StorageDatabaseDomain[] = [
  "whitelist",
  "blocklist",
  "temporaryAdBypass",
  "blocklistRemovalOutbox",
  "chatState",
  "chatQa",
  "aiMemory",
];

/** SQLite 未 ACK 主键上限；主线程每领域独立检查，Worker 六表共用，超限拒收新事实。 */
export const STORAGE_PENDING_MAX_ENTRIES: number = 8_192;

/** SQLite 未 ACK 字节上限；主线程每领域与 Worker 六表总预算在失败期间同样生效。 */
export const STORAGE_PENDING_MAX_BYTES: number = 32 * 1_024 * 1_024;

/** SQLite 连续事务失败的重试上限；到达后通知宿主停止新业务。 */
export const STORAGE_WRITE_MAX_FAILURES: number = 3;
