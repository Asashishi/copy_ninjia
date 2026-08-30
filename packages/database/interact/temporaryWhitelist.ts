import { and, eq, inArray, lt } from "drizzle-orm";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../consts/identityStorage";
import { temporaryWhitelistEntries } from "../schema/temporaryWhitelist";
import type { StorageDatabase } from "../../types/storageDatabase";
import type { StoredTemporaryWhitelistActivity } from "../../types/temporaryWhitelist";

/** 按身份批量读取临时白名单累计行；调用方负责叠加尚未提交的最终值。 */
export function readStoredTemporaryWhitelistActivities(
  database: StorageDatabase,
  ids: readonly number[]
): readonly StoredTemporaryWhitelistActivity[] {
  if (ids.length === 0) return [];
  if (ids.length > IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES) {
    throw new Error(
      `Temporary whitelist reads accept at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs.`
    );
  }
  return database.select().from(temporaryWhitelistEntries)
    .where(inArray(temporaryWhitelistEntries.id, ids)).all();
}

/** 东京零点物理删除滚动 24 小时前已停止发言的未授权累计行。 */
export function deleteExpiredTemporaryWhitelistActivities(
  database: StorageDatabase,
  cutoff: number
): void {
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) {
    throw new RangeError("Temporary whitelist cleanup cutoff must be a non-negative safe integer.");
  }
  database.delete(temporaryWhitelistEntries)
    .where(and(
      eq(temporaryWhitelistEntries.tempWhite, false),
      lt(temporaryWhitelistEntries.countedAt, cutoff)
    )).run();
}
