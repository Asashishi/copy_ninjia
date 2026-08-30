import { join } from "node:path";

/** 黑名单和白名单各自在主线程保留的热查询 LRU 容量。 */
export const IDENTITY_READ_CACHE_MAX_ENTRIES: number = 8_192;

/**
 * 单次跨线程冷读携带的主键上限；**必须严格小于** IDENTITY_READ_CACHE_MAX_ENTRIES。
 *
 * 两者相等时，同一次预取的第 N+1 块会把第 N 块整块挤出 LRU：`/batch_kick` 那种
 * 上万条的批量路径预取完成后只剩最后一块是热的，被挤掉的白名单管理员按冷未命中
 * 判成「不在白名单」而被踢出（见 whitelist.ts 的 isWhitelisted）。留出余量
 * 还能容纳同一条命令自己的目标身份预取。
 */
export const IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES: number = 4_096;

/**
 * 群级黑名单补扫一次从 SQLite 读取并投给 Anti-Raid Worker 的主键数上限。
 *
 * 游标页、跨线程消息与单群在途处置共用这一上限；不得把多页重新拼成全量数组。
 * 所属模块：infra/blocklist/、workers/diskIO/storageDatabase/identityPolicy.ts。
 */
export const BLOCKLIST_SWEEP_PAGE_SIZE: number = 512;

/** 每张业务表独立累计到该变化数时，立即用显式事务提交当前全部待写变化。 */
export const IDENTITY_WRITE_BATCH_MAX_ENTRIES: number = 128;

/**
 * 游标读取允许叠加的 Worker 事务内黑名单变化上限。
 *
 * 正常补扫在每页前先 flush 并确认主线程 revision 已 ACK，因此这里通常为零；
 * 该硬顶只兜并发写入和异常恢复，防止读请求为合并未提交变化重新物化无界集合。
 * 所属模块：workers/diskIO/storageDatabase/identityPolicy.ts。
 */
export const BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES: number =
  IDENTITY_WRITE_BATCH_MAX_ENTRIES;

/** 第一条待写变化进入后，即使未满批也必须在该窗口内提交。 */
export const IDENTITY_WRITE_FLUSH_INTERVAL_MS: number = 30_000;

/** SQLite 当前唯一受支持的 schema 版本。 */
export const IDENTITY_DATABASE_SCHEMA_VERSION: number = 7;

/** 历史文本初始 migration 的时间戳；用于核验当前库的已发布谱系。 */
export const IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT: number =
  20_260_811_000_000;

/** 历史文本初始 migration 的 SHA-256；用于核验历史 JSONB 转换谱系。 */
export const IDENTITY_DATABASE_TEXT_MIGRATION_HASH: string =
  "be64993ef4059e0fff1491bdbacc67ee9bb6b6d8097842036c7903c8c4aed93a";

/** 历史文本转 JSONB migration 的时间戳；与文本来源指纹配对。 */
export const IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT: number =
  20_260_811_010_000;

/** 历史文本转 JSONB migration 的 SHA-256；用于拒绝缺失、乱序或被改写的来源。 */
export const IDENTITY_DATABASE_JSONB_MIGRATION_HASH: string =
  "cb91b39a954c1638dcdc98e97ea0bfec947ea3cc1c377f39f45834bbda9d0cd3";

/** 当前直建 JSONB 的初始 migration SHA-256；与历史两步来源互斥。 */
export const IDENTITY_DATABASE_CURRENT_BASE_MIGRATION_HASH: string =
  "6c68bc6862efa69ffc2fbd29284275a7e4094de3e8e3206f7ae19ca3b9da0000";

/** 新增白名单代加权限 migration 的时间戳；两种合法基础谱系都必须包含。 */
export const IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT: number =
  20_260_812_000_000;

/** 新增白名单代加权限 migration 的 SHA-256；用于核验当前库谱系。 */
export const IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH: string =
  "b227cd2cfb34ffa77f50dac3c2b018a1294ceca4009a3c804eeff55e8a3c932e";

/** 新增群状态表 migration 的时间戳。 */
export const IDENTITY_DATABASE_CHAT_STATE_MIGRATION_CREATED_AT: number =
  20_260_813_000_000;

/** 新增群状态表 migration 的 SHA-256；部署迁移据此拒绝未知谱系。 */
export const IDENTITY_DATABASE_CHAT_STATE_MIGRATION_HASH: string =
  "35147ec6645084114dfbfd3328652c6464810a83a94d717424691de354f7208e";

/** 新增群问答表 migration 的时间戳。 */
export const IDENTITY_DATABASE_CHAT_QA_MIGRATION_CREATED_AT: number =
  20_260_823_000_000;

/** 新增群问答表 migration 的 SHA-256；部署迁移据此拒绝未知谱系。 */
export const IDENTITY_DATABASE_CHAT_QA_MIGRATION_HASH: string =
  "e1e14c54793d5e76e89c959c2c2ebdaf005b64a2e7e9c5998c1ba2fabefd107a";

/** 新增临时白名单关系列 migration 的时间戳。 */
export const IDENTITY_DATABASE_TEMPORARY_WHITELIST_MIGRATION_CREATED_AT: number =
  20_260_829_000_000;

/** 新增临时白名单关系列 migration 的 SHA-256；部署迁移据此拒绝未知谱系。 */
export const IDENTITY_DATABASE_TEMPORARY_WHITELIST_MIGRATION_HASH: string =
  "9a5d4cf250abc3881ab6cebb7f7be2c2d80596b47e3872f490e19602a304c978";

/** 首日临时免检与连续七日永久免检 migration 的时间戳。 */
export const IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_CREATED_AT: number =
  20_260_830_000_000;

/** 首日临时免检与连续七日永久免检 migration 的 SHA-256。 */
export const IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_HASH: string =
  "6e1d6777fdc2f7cac747be2c6f6e0b2ca7a2ce30dab8d7cd8dcdb33866391528";

/** SQLite 表级 CHECK 对自产 JSONB 做常数时间外壳校验的标志位。 */
export const IDENTITY_DATABASE_JSONB_VALIDATION_FLAG: number = 0x04;

/** 启动校验逐行确认内容是严格 SQLite JSONB 的标志位。 */
export const IDENTITY_DATABASE_JSONB_STRICT_VALIDATION_FLAG: number = 0x08;

/** storage_metadata 的唯一 schema 版本值；写入边界会把它转换为 JSONB。 */
export const IDENTITY_DATABASE_SCHEMA_DATA: string = JSON.stringify(
  { version: IDENTITY_DATABASE_SCHEMA_VERSION }
);

/** storage_metadata 中记录 schema 版本的固定主键。 */
export const IDENTITY_DATABASE_SCHEMA_KEY: string = "schema-version";

/** SQLite 目录权限；setgid 保证旁路文件继承部署数据根的协作组。 */
export const IDENTITY_DATABASE_DIRECTORY_MODE: number = 0o2770;

/** SQLite 主库及 WAL/SHM 旁路文件权限；owner 与部署协作组均可读写。 */
export const IDENTITY_DATABASE_FILE_MODE: number = 0o660;

/** Drizzle 内建 migrator 读取的身份数据库 schema migration 目录。 */
export const IDENTITY_DATABASE_MIGRATIONS_DIR: string = join(
  import.meta.dir,
  "../database/schema/migrations"
);
