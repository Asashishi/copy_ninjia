import { and, inArray, isNull, lt, or } from "drizzle-orm";
import { DAY_MS } from "../../consts/diskIO/common";
import { IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES } from "../../consts/identityStorage";
import { temporaryAdBypassEntries } from "../schema/temporaryAdBypass";
import type { StorageDatabase } from "../../types/storageDatabase";
import type { StoredTemporaryAdBypassActivity } from "../../types/temporaryAdBypass";

/** 按身份批量读取临时广告免检累计行；调用方负责叠加尚未提交的最终值。 */
export function readStoredTemporaryAdBypassActivities(
  database: StorageDatabase,
  ids: readonly number[]
): readonly StoredTemporaryAdBypassActivity[] {
  if (ids.length === 0) return [];
  if (ids.length > IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES) {
    throw new Error(
      `Temporary ad bypass reads accept at most ${IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES} IDs.`
    );
  }
  return database.select().from(temporaryAdBypassEntries)
    .where(inArray(temporaryAdBypassEntries.id, ids)).all();
}

/** 删除不属于当天、也未在刚结束的东京日达标的累计行。 */
export function deleteStaleTemporaryAdBypassActivities(
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
    throw new RangeError("Temporary ad bypass cleanup day bounds must be increasing non-negative safe integers.");
  }
  database.delete(temporaryAdBypassEntries)
    .where(and(
      lt(temporaryAdBypassEntries.countedAt, currentDayStart),
      or(
        isNull(temporaryAdBypassEntries.qualifiedAt),
        lt(temporaryAdBypassEntries.qualifiedAt, previousDayStart)
      )
    )).run();
}
