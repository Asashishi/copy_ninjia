import { and, inArray, isNull, lt, or } from "drizzle-orm";
import { DAY_MS } from "../../consts/diskIO/common";
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

/** 删除不属于当天、也未在刚结束的东京日达标的累计行。 */
export function deleteStaleTemporaryWhitelistActivities(
  database: StorageDatabase,
  currentDayStart: number,
  previousDayStart: number
): void {
  if (
    !Number.isSafeInteger(currentDayStart) ||
    !Number.isSafeInteger(previousDayStart) ||
    previousDayStart < 0 ||
    currentDayStart - previousDayStart !== DAY_MS
  ) {
    throw new RangeError("Temporary whitelist cleanup day bounds must be increasing non-negative safe integers.");
  }
  database.delete(temporaryWhitelistEntries)
    .where(and(
      lt(temporaryWhitelistEntries.countedAt, currentDayStart),
      or(
        isNull(temporaryWhitelistEntries.qualifiedAt),
        lt(temporaryWhitelistEntries.qualifiedAt, previousDayStart)
      )
    )).run();
}
