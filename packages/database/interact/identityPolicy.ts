import { asc, eq, gt, inArray, sql } from "drizzle-orm";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../consts/identityStorage";
import { blocklistEntries, whitelistEntries } from "../schema/identityPolicy";
import { jsonbTextProjection } from "../schema/jsonb";
import type { IdentityPolicyTable } from "../../types/identityPolicy";
import type {
  StorageDatabase,
  StoredIdentityIdLookups,
  StoredIdentityIdRow,
  StoredIdentityPolicyRow,
} from "../../types/storageDatabase";

/**
 * 为一条连接建两条「主键是否已持久化」的预编译语句（白/黑名单各一）。
 *
 * 这个查询在写入路径上是按条目调的（workers/diskIO/storageDatabase/identityPolicy.ts
 * 的 assertOppositePolicyAbsent），一批 IDENTITY_WRITE_BATCH_MAX_ENTRIES 条就要走
 * 同样多次。现场构建 Drizzle 查询每次约 57 µs，光拼 SQL 就比那一批唯一的一次
 * fsync 还贵；预编译后单次约 1 µs，整批的落盘延迟才由磁盘而不是查询构建决定。
 *
 * 本函数只负责**建**，不持有：语句归谁、活多久由调用侧决定（Disk I/O Worker 把
 * 它挂在 cache/workers/diskIO/storageDatabase.ts 的连接级 WeakMap 上）。本文件是
 * 不接触任何线程独占缓存的叶子模块，这条边界不要在这里破。
 */
export function prepareStoredIdentityIdLookups(
  database: StorageDatabase
): StoredIdentityIdLookups {
  return {
    whitelist: database.select({ id: whitelistEntries.id }).from(whitelistEntries)
      .where(eq(whitelistEntries.id, sql.placeholder("id"))).prepare(),
    blocklist: database.select({ id: blocklistEntries.id }).from(blocklistEntries)
      .where(eq(blocklistEntries.id, sql.placeholder("id"))).prepare(),
  };
}

/**
 * 按唯一主键稳定顺序读取已提交黑名单的一段游标页。
 * limit 由上层固定硬顶；本函数不使用 offset，名单增长时单页查询仍为有界工作。
 */
export function readStoredBlocklistIdPage(
  database: StorageDatabase,
  afterId: number | null,
  limit: number
): readonly number[] {
  const rows: StoredIdentityIdRow[] = database
    .select({ id: blocklistEntries.id })
    .from(blocklistEntries)
    .where(afterId === null ? undefined : gt(blocklistEntries.id, afterId))
    .orderBy(asc(blocklistEntries.id))
    .limit(limit)
    .all();
  return rows.map((row: StoredIdentityIdRow): number => row.id);
}

/** 批量读取某名单的已提交行；JSONB 解码统一经过 schema 文本投影。 */
export function readStoredIdentityPolicies(
  database: StorageDatabase,
  table: IdentityPolicyTable,
  ids: readonly number[]
): readonly StoredIdentityPolicyRow[] {
  if (ids.length === 0) return [];
  if (ids.length > IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES) {
    throw new Error(
      `Identity policy reads accept at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs.`
    );
  }
  return table === "whitelist"
    ? database
      .select({ id: whitelistEntries.id, data: jsonbTextProjection(whitelistEntries.data) })
      .from(whitelistEntries)
      .where(inArray(whitelistEntries.id, ids))
      .all()
    : database
      .select({ id: blocklistEntries.id, data: jsonbTextProjection(blocklistEntries.data) })
      .from(blocklistEntries)
      .where(inArray(blocklistEntries.id, ids))
      .all();
}
