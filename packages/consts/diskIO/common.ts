import type { DiskIORequestOutcome } from "../../types/diskIO/replies";

/** Disk I/O Worker 创建/接管的 JSON 统一为普通系统用户可读、仅属主可写。 */
export const PERSISTED_FILE_MODE: number = 0o644;

/** Disk I/O 主线程等待启动/运行时恢复及读取请求的统一上限。 */
export const LOAD_TIMEOUT_MS: number = 30_000;

/** Disk I/O Worker 重建期间主线程最多暂存的业务消息数。 */
export const DEFAULT_MAX_PENDING_BUSINESS_MESSAGES: number = 45_000;

/**
 * Disk I/O Worker 重建时各主线程镜像的固定恢复顺序；数值越小越先执行。
 * 显式排序；数值之间预留间隔，供新增领域插入。
 */
export const DISK_IO_RESPAWN_PRIORITIES: Readonly<{
  CHAT_STATE: number;
  CHAT_QA: number;
  TEMPORARY_AD_BYPASS: number;
  BLOCKLIST: number;
  AI_MEMORY: number;
  ANTI_RAID_VERIFICATION: number;
  DAILY_LUCK: number;
  WED_MEMBERS: number;
  JOIN_LOG: number;
}> = {
  CHAT_STATE: 50,
  // 排在群状态之后：问答挂在群上，先重放群状态再重放它的问答。
  CHAT_QA: 60,
  // 先重放广告 true 产生的累计删除，再重放同身份的永久拉黑最终值。
  TEMPORARY_AD_BYPASS: 90,
  BLOCKLIST: 100,
  AI_MEMORY: 200,
  ANTI_RAID_VERIFICATION: 300,
  DAILY_LUCK: 400,
  WED_MEMBERS: 500,
  JOIN_LOG: 600,
};

/**
 * 广告命中样本文件超过这个大小就轮转成一个带时间戳的归档，重新从空文件写起。
 *
 * 追加游标在 Worker 重建后与每次追加失败后作废，下一条命中需要对整份
 * 文件重新读回、解析并校验。归档按 AD_SAMPLE_ARCHIVE_RETENTION_DAYS 保留。
 * 所属模块：workers/diskIO/adSampleFile.ts。
 */
export const AD_SAMPLE_FILE_MAX_BYTES: number = 8 * 1_024 * 1_024;

/**
 * 广告样本归档保留的配置时区的自然日数量，包含当天。
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

/**
 * main -> Disk I/O 逐请求等待表（infra/diskIO/requests.ts）的超时与投递被拒结局。所有请求共用
 * 这两个只读对象，Error 在发起方解包时才按领域名构造。
 */
export const DISK_IO_REQUEST_TIMED_OUT: Readonly<DiskIORequestOutcome<never>> = { ok: false, failure: "timedOut" };
/** 同 DISK_IO_REQUEST_TIMED_OUT，投递被 Worker 同步拒收时的结局。 */
export const DISK_IO_REQUEST_REJECTED: Readonly<DiskIORequestOutcome<never>> = { ok: false, failure: "rejected" };
