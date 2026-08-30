import { pendingTemporaryWhitelistWrites } from
  "../../../cache/workers/diskIO/storageDatabase";
import {
  TEMPORARY_WHITELIST_INACTIVITY_TTL_MS,
} from "../../../consts/temporaryWhitelist";
import { assertTelegramIdentityId } from "../../../database/codec/identity";
import { assertTemporaryWhitelistActivity } from
  "../../../database/codec/temporaryWhitelist";
import {
  deleteExpiredTemporaryWhitelistActivities,
} from "../../../database/interact/temporaryWhitelist";
import type {
  TemporaryWhitelistWriteDiskMessage,
} from "../../../types/diskIO/messages";
import type { IdentityPersistenceReply } from "../../../types/diskIO/replies";
import type {
  PendingTemporaryWhitelistWrite,
} from "../../../types/temporaryWhitelist";
import { hasEffectiveBlocklistIdentity } from "./identityPolicy";
import { requireStorageDatabase, storageSource } from "./context";
import { flushIfStorageFull } from "./flush";

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
  if (message.activity !== null) {
    assertTemporaryWhitelistActivity(message.activity, source);
    if (hasEffectiveBlocklistIdentity(message.id)) {
      throw new Error(
        `Identity ${message.id} cannot exist in temporary_whitelist_entries and blocklist_entries.`
      );
    }
  }
  const current: PendingTemporaryWhitelistWrite | undefined =
    pendingTemporaryWhitelistWrites.get(message.id);
  if (current !== undefined && current.revision >= message.revision) return;
  pendingTemporaryWhitelistWrites.set(message.id, {
    activity: message.activity,
    revision: message.revision,
  });
  flushIfStorageFull(reply);
}

/** 立即物理清理过期的未授权累计；已授权成员保留到显式删除。 */
export function sweepExpiredTemporaryWhitelistActivities(
  now: number = Date.now()
): void {
  if (!Number.isSafeInteger(now) || now < TEMPORARY_WHITELIST_INACTIVITY_TTL_MS) {
    throw new RangeError("Temporary whitelist cleanup time must be a current safe integer.");
  }
  deleteExpiredTemporaryWhitelistActivities(
    requireStorageDatabase(),
    now - TEMPORARY_WHITELIST_INACTIVITY_TTL_MS
  );
}
