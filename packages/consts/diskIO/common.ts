/** Disk I/O Worker 创建/接管的 JSON 统一为普通系统用户可读、仅属主可写。 */
export const PERSISTED_FILE_MODE: number = 0o644;

/** 主线程等待 Disk I/O Worker 完成启动恢复的超时。 */
export const LOAD_TIMEOUT_MS: number = 5_000;

/** Disk I/O Worker 重建期间主线程最多暂存的业务消息数。 */
export const DEFAULT_MAX_PENDING_BUSINESS_MESSAGES: number = 10_000;

/** 公历日的固定毫秒数；只与固定 UTC+9 偏移配合，不用于有夏令时的时区。 */
export const DAY_MS: number = 24 * 60 * 60 * 1_000;
