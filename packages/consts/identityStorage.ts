import { join } from "node:path";

/** 黑名单和白名单各自在主线程保留的热查询 LRU 容量。 */
export const IDENTITY_READ_CACHE_MAX_ENTRIES: number = 8_196;

/**
 * 单次跨线程冷读携带的主键上限；**必须严格小于** IDENTITY_READ_CACHE_MAX_ENTRIES。
 *
 * 两者相等时，同一次预取的第 N+1 块会把第 N 块整块挤出 LRU：`/batch_kick` 那种
 * 上万条的批量路径预取完成后只剩最后一块是热的，被挤掉的白名单管理员按冷未命中
 * 判成「不在白名单」而被踢出（见 whitelist.ts 的 isWhitelisted）。留出余量
 * 还能容纳同一条命令自己的目标身份预取。
 */
export const IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES: number = 4_096;

/** 每张业务表独立累计到该变化数时，立即用显式事务提交当前全部待写变化。 */
export const IDENTITY_WRITE_BATCH_MAX_ENTRIES: number = 128;

/** 第一条待写变化进入后，即使未满批也必须在该窗口内提交。 */
export const IDENTITY_WRITE_FLUSH_INTERVAL_MS: number = 30_000;

/** SQLite 当前唯一受支持的 schema 版本。 */
export const IDENTITY_DATABASE_SCHEMA_VERSION: number = 3;

/** 旧文本 SQLite 初始 migration 的时间戳；只用于识别已部署 v2 谱系。 */
export const IDENTITY_DATABASE_TEXT_MIGRATION_CREATED_AT: number = 20_260_811_000_000;

/** 旧文本 SQLite 初始 migration 的 SHA-256；只用于拒绝未知迁移谱系。 */
export const IDENTITY_DATABASE_TEXT_MIGRATION_HASH: string =
  "be64993ef4059e0fff1491bdbacc67ee9bb6b6d8097842036c7903c8c4aed93a";

/** 已部署文本转 JSONB migration 的时间戳；v2 生产库必须包含此项。 */
export const IDENTITY_DATABASE_JSONB_MIGRATION_CREATED_AT: number =
  20_260_811_010_000;

/** 已部署文本转 JSONB migration 的 SHA-256；v2 生产库必须精确匹配。 */
export const IDENTITY_DATABASE_JSONB_MIGRATION_HASH: string =
  "cb91b39a954c1638dcdc98e97ea0bfec947ea3cc1c377f39f45834bbda9d0cd3";

/** 新建库直达 JSONB 的初始 migration SHA-256；用于识别全新 v3 谱系。 */
export const IDENTITY_DATABASE_CURRENT_BASE_MIGRATION_HASH: string =
  "6c68bc6862efa69ffc2fbd29284275a7e4094de3e8e3206f7ae19ca3b9da0000";

/** 新增白名单代加权限 migration 的时间戳。 */
export const IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_CREATED_AT: number =
  20_260_812_000_000;

/** 新增白名单代加权限 migration 的 SHA-256。 */
export const IDENTITY_DATABASE_WHITELIST_PERMISSION_MIGRATION_HASH: string =
  "b227cd2cfb34ffa77f50dac3c2b018a1294ceca4009a3c804eeff55e8a3c932e";

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
