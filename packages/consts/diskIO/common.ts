/** Disk I/O Worker 创建/接管的 JSON 统一为普通系统用户可读、仅属主可写。 */
export const PERSISTED_FILE_MODE: number = 0o644;

/** Disk I/O 主线程等待启动/运行时恢复及读取请求的统一上限；大体量状态最多允许三十秒。 */
export const LOAD_TIMEOUT_MS: number = 30_000;

/** Disk I/O Worker 重建期间主线程最多暂存的业务消息数。 */
export const DEFAULT_MAX_PENDING_BUSINESS_MESSAGES: number = 45_000;

/**
 * Disk I/O Worker 重建时各主线程镜像的固定恢复顺序；数值越小越先执行。
 * 显式排序避免模块 import 先后改变恢复协议，预留间隔便于新增领域插入。
 */
export const DISK_IO_RESPAWN_PRIORITIES: Readonly<{
  CHAT_STATE: number;
  CHAT_QA: number;
  TEMPORARY_WHITELIST: number;
  BLOCKLIST: number;
  AI_MEMORY: number;
  ANTI_RAID_VERIFICATION: number;
  DAILY_LUCK: number;
  WED_MEMBERS: number;
}> = {
  CHAT_STATE: 50,
  // 排在群状态之后：问答挂在群上，先让那一群的状态回到位再重放它的问答，
  // 失败诊断的因果顺序才和运行时一致。
  CHAT_QA: 60,
  // 先重放广告 true 产生的累计删除，再重放同身份的永久拉黑最终值。
  TEMPORARY_WHITELIST: 90,
  BLOCKLIST: 100,
  AI_MEMORY: 200,
  ANTI_RAID_VERIFICATION: 300,
  DAILY_LUCK: 400,
  WED_MEMBERS: 500,
};

/** 公历日的固定毫秒数；只与固定 UTC+9 偏移配合，不用于有夏令时的时区。 */
export const DAY_MS: number = 24 * 60 * 60 * 1_000;

/**
 * 广告命中样本文件超过这个大小就轮转成一个带时间戳的归档，重新从空文件写起。
 *
 * 轮转的理由不是磁盘占用，是**读回成本**：追加游标在 Worker 重建后与每次追加
 * 失败后都会作废，下一条命中因此要对整份文件重跑一次同步 readFileSync +
 * JSON.parse（必要时还要加一次截断修复的全扫），压在唯一那条串行 I/O 线程上。
 * 不设上界的话，攒上几个月就能把同期的 `/block` 落盘确认拖过
 * DISK_IO_FLUSH_TIMEOUT_MS，让管理员看到「小本本没能写进硬盘」——而那条黑名单
 * 其实完全写得进去。
 *
 * 归档按 AD_SAMPLE_ARCHIVE_RETENTION_DAYS 保留，限制旁路素材的总磁盘占用。
 * 所属模块：workers/diskIO/adSampleFile.ts。
 */
export const AD_SAMPLE_FILE_MAX_BYTES: number = 8 * 1_024 * 1_024;

/**
 * 广告样本归档保留的东京自然日数量，包含当天。
 * 所属模块：workers/diskIO/adSampleFile.ts。
 */
export const AD_SAMPLE_ARCHIVE_RETENTION_DAYS: number = 15;

/**
 * 广告样本归档的严格文件名格式：无序号或带正整数序号；日期本身还要由调用方
 * 做公历有效性校验。无 g 标志，跨调用复用 exec 时不会保存 lastIndex。
 * 所属模块：workers/diskIO/adSampleFile.ts。
 */
export const AD_SAMPLE_ARCHIVE_FILENAME_PATTERN: Readonly<RegExp> =
  /^sample\.(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d*))?\.json$/;
