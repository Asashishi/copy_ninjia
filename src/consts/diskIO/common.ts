/** Disk I/O Worker 创建/接管的 JSON 统一为普通系统用户可读、仅属主可写。 */
export const PERSISTED_FILE_MODE: number = 0o644;

/** 主线程等待 Disk I/O Worker 完成启动恢复的超时。 */
export const LOAD_TIMEOUT_MS: number = 5_000;

/** Disk I/O Worker 重建期间主线程最多暂存的业务消息数。 */
export const DEFAULT_MAX_PENDING_BUSINESS_MESSAGES: number = 10_000;
