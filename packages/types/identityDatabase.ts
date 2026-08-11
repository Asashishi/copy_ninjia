import type { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { identityDatabaseSchema } from "../database/schema/identity";

/** Drizzle 绑定 Bun SQLite 与身份 schema 后的同步句柄。 */
export type IdentityDatabase = BunSQLiteDatabase<typeof identityDatabaseSchema> & {
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

/** SQLite 自身元数据表的一行。 */
export interface StoredIdentityMetadataRow {
  readonly key: string;
  readonly data: string;
}

/** 一次严格恢复读取的四张身份数据库表。 */
export interface IdentityDatabaseRows {
  readonly whitelist: readonly StoredIdentityPolicyRow[];
  readonly blocklist: readonly StoredIdentityPolicyRow[];
  readonly removals: readonly StoredPendingRemovalRow[];
  readonly metadata: readonly StoredIdentityMetadataRow[];
}

/** 三张业务表事务缓冲中一项主键的最终 JSON 文本；null 表示删除。 */
export interface IdentityDatabaseChange {
  readonly data: string | null;
}

/** SQLite `integrity_check` 返回的一行；正常数据库必须只返回字符串 `ok`。 */
export interface IdentityDatabaseIntegrityRow {
  readonly integrity_check: string;
}

/** Drizzle 身份库迁移日志中用于严格识别部署谱系的一项。 */
export interface IdentityDatabaseMigrationJournalEntry {
  readonly createdAt: number;
  readonly hash: string;
}

/** 一张身份表的 Drizzle data 声明及当前 SQLite 存储类型统计。 */
export interface IdentityDatabaseJsonStorageRow {
  readonly tableName: string;
  readonly declaredType: string | null;
  readonly rowCount: number;
  readonly textRows: number;
  readonly blobRows: number;
  readonly invalidJsonbRows: number;
}
