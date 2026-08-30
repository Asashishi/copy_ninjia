import type { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { storageDatabaseSchema } from "../database/schema/storage";

/** Drizzle 绑定 Bun SQLite 与共享运行时 schema 后的同步句柄。 */
export type StorageDatabase = BunSQLiteDatabase<typeof storageDatabaseSchema> & {
  $client: Database;
};

/** 黑白名单 JSONB 经 SQLite `json()` 规范化后的文本行。 */
export interface StoredIdentityPolicyRow {
  readonly id: number;
  readonly data: string;
}

/** 只投影黑名单主键时使用的轻量数据库行。 */
export interface StoredIdentityIdRow {
  readonly id: number;
}

/** 待踢成员 JSONB 经 SQLite `json()` 规范化后的文本行。 */
export interface StoredPendingRemovalRow {
  readonly removalId: number;
  readonly data: string;
}

/** 生产启动分页读取的待踢行；data 为 null 表示存储形态或严格 JSONB 校验失败。 */
export interface StoredPendingRemovalStartupRow {
  readonly removalId: number;
  readonly data: string | null;
  readonly storageClass: string;
}

/** 群状态 JSONB 经 SQLite `json()` 规范化后的文本行。 */
export interface StoredChatStateRow {
  readonly chatId: number;
  readonly data: string;
}

/**
 * 群问答表的一行。主键是 (chatId, q) 复合键，因此这里两列都是标识而非载荷。
 */
export interface StoredChatQaRow {
  readonly chatId: number;
  readonly q: string;
  readonly data: string;
}

/** SQLite 自身元数据表的一行。 */
export interface StoredStorageMetadataRow {
  readonly key: string;
  readonly data: string;
}

/**
 * 生产启动恢复载荷；名单只取计数，群状态只恢复正文而不执行启动正确性校验。
 *
 * 不含 schema 元数据：版本判定必须早于当前业务表的读取，因此那一行由
 * readStorageDatabaseSchemaMetadata 单独取，不从这里回传。
 */
export interface StorageDatabaseStartupRows {
  readonly whitelistEntryCount: number;
  readonly blocklistEntryCount: number;
  readonly chatStates: readonly StoredChatStateRow[];
  readonly chatQa: readonly StoredChatQaRow[];
}

/** 事务缓冲中一项主键的最终 JSON 文本；null 表示删除。 */
export interface StorageDatabaseChange {
  readonly data: string | null;
}

/** Drizzle 迁移日志中用于严格识别部署谱系的一项。 */
export interface StorageDatabaseMigrationJournalEntry {
  readonly createdAt: number;
  readonly hash: string;
}

/** 一张 JSONB 表的 Drizzle data 声明及当前 SQLite 存储类型统计。 */
export interface StorageDatabaseJsonStorageRow {
  readonly tableName: string;
  readonly declaredType: string | null;
  readonly rowCount: number;
  readonly textRows: number;
  readonly blobRows: number;
  readonly invalidJsonbRows: number;
}

/**
 * 一条预编译的主键存在性查询；只用到按占位符取单行这一种调用。
 *
 * 占位符表照 Drizzle 的 `prepare().get()` 原样写成 `Record<string, unknown>`：
 * 那个形参就是这个类型，换成具名 interface 会因为缺隐式索引签名而赋不进去。
 * 本查询唯一的占位符是 `sql.placeholder("id")`。
 */
export interface StoredIdentityIdLookup {
  readonly get: (
    values: Record<string, unknown>
  ) => StoredIdentityIdRow | undefined;
}

/** 三张身份关系各一条预编译语句，随连接一起存活。 */
export interface StoredIdentityIdLookups {
  readonly whitelist: StoredIdentityIdLookup;
  readonly blocklist: StoredIdentityIdLookup;
  readonly temporaryWhitelist: StoredIdentityIdLookup;
}
