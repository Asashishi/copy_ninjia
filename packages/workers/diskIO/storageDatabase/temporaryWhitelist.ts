import { storagePendingBudget } from "../../../cache/workers/diskIO/storageDatabase";
import { storageWriteCost } from "../../../libs/storageWriteBudget";
import { pendingTemporaryWhitelistWrites } from
  "../../../cache/workers/diskIO/storageDatabase";
import { DAY_MS } from "../../../consts/diskIO/common";
import { assertTelegramIdentityId } from "../../../database/codec/identity";
import { assertTemporaryWhitelistActivity } from
  "../../../database/codec/temporaryWhitelist";
import {
  deleteStaleTemporaryWhitelistActivities,
} from "../../../database/interact/temporaryWhitelist";
import { getTokyoDayStartTimestamp } from "../../../libs/time";
import { isTemporaryWhitelistActivityRetained } from
  "../../../states/temporaryWhitelist";
import type {
  TemporaryWhitelistWriteDiskMessage,
} from "../../../types/diskIO/messages";
import type { IdentityPersistenceReply } from "../../../types/diskIO/replies";
import type {
  PendingTemporaryWhitelistWrite,
} from "../../../types/temporaryWhitelist";
import { hasEffectiveBlocklistIdentity } from "./identityPolicy";
import { requireStorageDatabase, storageSource } from "./context";
import { flushIfStorageFull, flushStorageDatabase } from "./flush";

/** 收下一条临时白名单累计最终值；同一主键的迟到 revision 不覆盖新值。 */
export function handleTemporaryWhitelistWrite(
  message: TemporaryWhitelistWriteDiskMessage,
  reply: IdentityPersistenceReply
): void {
  const source: string = storageSource("temporary_whitelist_entries", message.id);
  assertTelegramIdentityId(message.id, source);
  if (!Number.isSafeInteger(message.revision) || message.revision < 1) {
    throw new Error(`${source}: revision must be a positive safe integer.`);
  }
  let activity: TemporaryWhitelistWriteDiskMessage["activity"] = message.activity;
  if (activity !== null) {
    assertTemporaryWhitelistActivity(activity, source);
    if (!isTemporaryWhitelistActivityRetained(activity, Date.now())) {
      activity = null;
    }
  }
  if (activity !== null) {
    if (hasEffectiveBlocklistIdentity(message.id)) {
      throw new Error(
        `Identity ${message.id} cannot exist in temporary_whitelist_entries and blocklist_entries.`
      );
    }
  }
  const current: PendingTemporaryWhitelistWrite | undefined =
    pendingTemporaryWhitelistWrites.get(message.id);
  if (current !== undefined && current.revision >= message.revision) return;
  storagePendingBudget.reserve(current === undefined ? 1 : 0, current === undefined ? storageWriteCost(null) : 0);
  pendingTemporaryWhitelistWrites.set(message.id, {
    activity,
    revision: message.revision,
  });
  flushIfStorageFull(reply);
}

/** 提交在途最终值后，清理未在刚结束东京日达标的旧累计。 */
export function maintainTemporaryWhitelistActivities(
  reply: IdentityPersistenceReply,
  now: number = Date.now()
): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("Temporary whitelist cleanup time must be a current safe integer.");
  }
  const currentDayStart: number = getTokyoDayStartTimestamp(now);
  if (currentDayStart < DAY_MS) {
    throw new RangeError("Temporary whitelist cleanup time must include a previous Tokyo day.");
  }
  flushStorageDatabase(reply);
  if (pendingTemporaryWhitelistWrites.size > 0) {
    throw new Error("Temporary whitelist cleanup requires all pending writes to be committed.");
  }
  deleteStaleTemporaryWhitelistActivities(
    requireStorageDatabase(),
    currentDayStart,
    currentDayStart - DAY_MS
  );
}
