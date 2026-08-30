/** Disk I/O Worker 每日维护在所属时区零点触发的 cron 表达式。 */
export const DISK_IO_MAINTENANCE_CRON: string = "0 0 * * *";

/** Disk I/O Worker 每日维护固定使用的 IANA 时区，不继承宿主机本地时区。 */
export const DISK_IO_MAINTENANCE_TIME_ZONE: string = "Asia/Tokyo";
