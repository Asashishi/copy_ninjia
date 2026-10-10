import { join } from "node:path";

/** 黑名单、白名单与临时广告免检各自在主线程保留的热查询 LRU 容量。 */
export const IDENTITY_READ_CACHE_MAX_ENTRIES: number = 8_192;

/**
 * 单次跨线程冷读携带的主键上限；**必须严格小于** IDENTITY_READ_CACHE_MAX_ENTRIES。
 *
 * 预热时已缓存的主键先刷新热度、冷键再整块写入；块不超过 LRU 容量，同一块里的
 * 主键写完后全部仍在缓存中，余量容纳同一条 update 的其它身份。
 * 破坏性批量处置不依赖这份缓存的驻留，按块直接取局部结论（见
 * infra/identityStorage/read.ts 的 readIdentityPolicyVerdicts）。
 */
export const IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES: number = 4_096;

/**
 * 群级黑名单补扫一次从 SQLite 读取并投给 Anti-Raid Worker 的主键数上限。
 *
 * 游标页、跨线程消息与单群在途处置共用这一上限；不得把多页重新拼成全量数组。
 * 所属模块：infra/identityStorage/sweep.ts、cache/main/blocklist.ts、workers/diskIO/storageDatabase/identityPolicy.ts。
 */
export const BLOCKLIST_SWEEP_PAGE_SIZE: number = 512;

/** 每张业务表独立累计到该变化数时，立即用显式事务提交当前全部待写变化。 */
export const IDENTITY_WRITE_BATCH_MAX_ENTRIES: number = 128;

/**
 * 游标读取允许叠加的 Worker 事务内黑名单变化上限。
 *
 * 补扫在每页前先 flush 并确认主线程 revision 已 ACK，叠加量通常为零；
 * 本上限约束并发写入与异常恢复时读请求合并的未提交变化数。
 * 所属模块：workers/diskIO/storageDatabase/identityPolicy.ts。
 */
export const BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES: number =
  IDENTITY_WRITE_BATCH_MAX_ENTRIES;

/** 第一条待写变化进入后，即使未满批也必须在该窗口内提交。 */
export const IDENTITY_WRITE_FLUSH_INTERVAL_MS: number = 30_000;

/**
 * 群问答未提交变化（按 (chatId, q) 计条，含删除墓碑）累计到该条数时，立即用显式事务
 * 提交当前全部待写变化。所属模块：workers/diskIO/storageDatabase/flush.ts。
 */
export const CHAT_QA_WRITE_BATCH_MAX_ENTRIES: number = 32;

/** SQLite 当前唯一受支持的 schema 版本。 */
export const IDENTITY_DATABASE_SCHEMA_VERSION: number = 13;

/** 初始 migration（0000_identity_storage，直建 JSONB 表）的时间戳；迁移谱系的第一条。所属模块：database/interact/inspection.ts。 */
export const IDENTITY_DATABASE_BASE_MIGRATION_CREATED_AT: number =
  20_260_811_000_000;

/** 初始 migration（0000_identity_storage）的 SHA-256。所属模块：database/interact/inspection.ts。 */
export const IDENTITY_DATABASE_BASE_MIGRATION_HASH: string =
  "6c68bc6862efa69ffc2fbd29284275a7e4094de3e8e3206f7ae19ca3b9da0000";

/** 新增白名单代加权限 migration 的时间戳；迁移谱系的第二条。 */
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

/** 新增临时广告免检关系列 migration 的时间戳。 */
export const IDENTITY_DATABASE_TEMPORARY_ACTIVITY_MIGRATION_CREATED_AT: number =
  20_260_829_000_000;

/** 新增临时广告免检关系列 migration 的 SHA-256；部署迁移据此拒绝未知谱系。 */
export const IDENTITY_DATABASE_TEMPORARY_ACTIVITY_MIGRATION_HASH: string =
  "9a5d4cf250abc3881ab6cebb7f7be2c2d80596b47e3872f490e19602a304c978";

/** 临时广告免检首日规则与连续合格日永久免检 migration 的时间戳。 */
export const IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_CREATED_AT: number =
  20_260_830_000_000;

/** 临时广告免检首日规则与连续合格日永久免检 migration 的 SHA-256。 */
export const IDENTITY_DATABASE_TEMPORARY_AD_BYPASS_MIGRATION_HASH: string =
  "6e1d6777fdc2f7cac747be2c6f6e0b2ca7a2ce30dab8d7cd8dcdb33866391528";

/** 翻译权限和群开关名称迁移的时间戳；当前数据库必须包含这条迁移。 */
export const IDENTITY_DATABASE_TRANSLATE_MIGRATION_CREATED_AT: number = 20_260_908_000_000;

/** 翻译权限和群开关名称迁移的 SHA-256；启动据此核验当前谱系。 */
export const IDENTITY_DATABASE_TRANSLATE_MIGRATION_HASH: string =
  "f36aba558a2b386c784140e85f5181d08e6909466181e253ea1cc77da88661c5";

/** SQLite 表级 CHECK 对自产 JSONB 做常数时间外壳校验的标志位。 */
export const IDENTITY_DATABASE_JSONB_VALIDATION_FLAG: number = 0x04;

/** 启动校验逐行确认内容是严格 SQLite JSONB 的标志位。 */
export const IDENTITY_DATABASE_JSONB_STRICT_VALIDATION_FLAG: number = 0x08;

/** storage_metadata 中 schema-version 行的当前值；写入边界会把它转换为 JSONB。 */
export const IDENTITY_DATABASE_SCHEMA_DATA: string = JSON.stringify(
  { version: IDENTITY_DATABASE_SCHEMA_VERSION }
);

/** storage_metadata 中记录 schema 版本的固定主键。 */
export const IDENTITY_DATABASE_SCHEMA_KEY: string = "schema-version";

/**
 * storage_metadata 中记录数据根绑定时区的固定主键；值形如 `{"timeZone":"<规范 IANA 名>"}`
 * （StorageTimeZoneMetadata）。建库时写入配置时区，启动与安装器只读比对，运行期不改写。
 * 所属模块：database/interact/initialization.ts、database/validation/storageRows.ts。
 */
export const IDENTITY_DATABASE_TIME_ZONE_KEY: string = "time-zone";

/**
 * 当前格式 storage_metadata 的完整主键集合：恰为 schema 版本与时区标记两行，缺项或多余键都拒绝启动。
 * 所属模块：database/validation/storageRows.ts。
 */
export const IDENTITY_DATABASE_METADATA_KEYS: readonly string[] = [
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_DATABASE_TIME_ZONE_KEY,
];

/** SQLite 目录权限；setgid 保证旁路文件继承部署数据根的协作组。 */
export const IDENTITY_DATABASE_DIRECTORY_MODE: number = 0o2770;

/** SQLite 主库及 WAL/SHM 旁路文件权限；owner 与部署协作组均可读写。 */
export const IDENTITY_DATABASE_FILE_MODE: number = 0o660;

/** Drizzle 内建 migrator 读取的身份数据库 schema migration 目录。 */
export const IDENTITY_DATABASE_MIGRATIONS_DIR: string = join(
  Bun.isStandaloneExecutable ? process.cwd() : join(import.meta.dir, "..", ".."),
  "packages/database/schema/migrations"
);

/** AI 上下文与人设迁移的固定时间戳，所属模块：数据库谱系校验。 */
export const AI_CONTEXT_MIGRATION_CREATED_AT: number = 20_260_915_000_000;
/** AI 上下文与人设迁移的 SHA-256，SQL 变更必须同步更新。 */
export const AI_CONTEXT_MIGRATION_HASH: string = "9e4c495581a707c70612433d28876334695775917fab534bba770850c8b8d0c4";

/** 新增清理上下文权限迁移的时间戳；当前数据库必须包含此条目。 */
export const CLEAR_CONTEXT_PERMISSION_MIGRATION_CREATED_AT: number = 20_260_915_010_000;

/** 清理上下文权限迁移的 SHA-256；启动据此核验当前谱系。 */
export const CLEAR_CONTEXT_PERMISSION_MIGRATION_HASH: string =
  "50aefd0c0916b681cae8914a589b7d50e212f368551551c186813299cde8242d";

/** 新增 `/h_image add` 权限迁移的时间戳；当前数据库必须紧接其后包含移除群人设迁移。所属模块：数据库谱系校验。 */
export const H_IMAGE_ADD_PERMISSION_MIGRATION_CREATED_AT: number = 20_260_920_000_000;

/** `/h_image add` 权限迁移的 SHA-256；SQL 变更必须同步更新，启动据此核验当前谱系。 */
export const H_IMAGE_ADD_PERMISSION_MIGRATION_HASH: string =
  "699c8bfe967c8c2b6d88963f3b8f59725c2743ce417211ffdbf76d7c94ad5226";

/** 移除群人设列与 `/prompt` 权限迁移的时间戳；当前数据库必须紧接其后包含时区标记迁移。所属模块：数据库谱系校验。 */
export const CHAT_PERSONA_REMOVAL_MIGRATION_CREATED_AT: number = 20_261_001_000_000;

/** 移除群人设列与 `/prompt` 权限迁移的 SHA-256；SQL 变更必须同步更新，启动据此核验当前谱系。 */
export const CHAT_PERSONA_REMOVAL_MIGRATION_HASH: string =
  "86b4dee97dbd407b3acefcb93f6dc848c90bbee8a52ef0be4d832fc264807eef";

/** 写入时区标记并升到当前 schema 版本的迁移时间戳；当前数据库必须以此条目结尾。所属模块：数据库谱系校验。 */
export const TIME_ZONE_MARKER_MIGRATION_CREATED_AT: number = 20_261_003_000_000;

/** 时区标记迁移的 SHA-256；SQL 变更必须同步更新，启动与冷迁移据此核验当前谱系。 */
export const TIME_ZONE_MARKER_MIGRATION_HASH: string =
  "0691bf88adb273181fd8e0365b8dddd1aa69b173c2a10534db6e43c6679741d1";
