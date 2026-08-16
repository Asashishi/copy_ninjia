import { eq, inArray } from "drizzle-orm";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../consts/identityStorage";
import { blocklistEntries, whitelistEntries } from "../schema/identityPolicy";
import { jsonbTextProjection } from "../schema/jsonb";
import type { IdentityPolicyTable } from "../../types/identityPolicy";
import type {
  StorageDatabase,
  StoredIdentityIdRow,
  StoredIdentityPolicyRow,
} from "../../types/storageDatabase";

/** 查询某名单主键是否已经持久化；使用 Drizzle get 避免构造单元素数组。 */
export function hasStoredIdentityPolicy(
  database: StorageDatabase,
  table: IdentityPolicyTable,
  id: number
): boolean {
  const row: StoredIdentityIdRow | undefined = table === "whitelist"
    ? database.select({ id: whitelistEntries.id }).from(whitelistEntries)
      .where(eq(whitelistEntries.id, id)).get()
    : database.select({ id: blocklistEntries.id }).from(blocklistEntries)
      .where(eq(blocklistEntries.id, id)).get();
  return row !== undefined;
}

/** 读取已提交黑名单主键，供 Worker 叠加其事务缓冲。 */
export function readStoredBlocklistIds(
  database: StorageDatabase
): readonly number[] {
  const rows: StoredIdentityIdRow[] = database
    .select({ id: blocklistEntries.id })
    .from(blocklistEntries)
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
