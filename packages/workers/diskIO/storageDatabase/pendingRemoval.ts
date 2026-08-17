import {
  latestRemovalSnapshotRevision,
  pendingRemovalSnapshotRevision,
  pendingRemovalWrites,
  removalSnapshot,
  removalSnapshotData,
} from "../../../cache/workers/diskIO/storageDatabase";
import { encodePendingBlockedRemovalData } from "../../../database/codec/identity";
import type { EncodedPendingBlockedRemoval } from "../../../database/codec/identity";
import type { PendingBlockedRemoval } from "../../../types/blocklist";
import type {
  BlocklistRemovalsDiskMessage,
  IdentityPersistenceReply,
} from "../../../types/diskIO";
import { storageSource } from "./context";
import {
  flushIfStorageFull,
  hasPendingStorageWrites,
} from "./flush";
import {
  hasAnyEffectiveBlocklistIdentity,
  hasEffectiveBlocklistIdentity,
} from "./identityPolicy";

function clonePendingRemoval(pending: PendingBlockedRemoval): PendingBlockedRemoval {
  return {
    params: pending.params.probeMembership
      ? { ...pending.params }
      : { ...pending.params, userIds: [...pending.params.userIds] },
    createdAt: pending.createdAt,
    attempts: pending.attempts,
    lastFailure: pending.lastFailure,
  };
}

/** 完整 outbox 快照转成按主键合并的 SQLite 行变化。 */
export function handlePendingRemovalSnapshot(
  message: BlocklistRemovalsDiskMessage,
  reply: IdentityPersistenceReply
): void {
  if (!Number.isSafeInteger(message.revision) || message.revision < 1) {
    throw new Error("Pending removal snapshot revision must be a positive safe integer.");
  }
  if (message.revision <= latestRemovalSnapshotRevision.current) return;
  const next: Map<number, PendingBlockedRemoval> = new Map();
  const encoded: Map<number, string> = new Map();
  for (const [removalId, raw] of message.removals) {
    if (next.has(removalId)) {
      throw new Error(`Pending removal snapshot contains duplicate removalId ${removalId}.`);
    }
    const { text: data, value: pending }: EncodedPendingBlockedRemoval =
      encodePendingBlockedRemovalData(
        raw,
        storageSource("pending_blocked_removals", removalId)
      );
    if (pending.params.removalId !== removalId) {
      throw new Error(`Pending removal row ${removalId} does not match params.removalId.`);
    }
    next.set(removalId, pending);
    encoded.set(removalId, data);
  }
  let hasAnyBlockedIdentity: boolean | undefined;
  for (const [removalId, pending] of next) {
    if (pending.params.probeMembership) {
      hasAnyBlockedIdentity ??= hasAnyEffectiveBlocklistIdentity();
      if (!hasAnyBlockedIdentity) {
        throw new Error(
          `Pending removal row ${removalId} requires at least one effective blocklist entry.`
        );
      }
      continue;
    }
    if (pending.params.userIds.some(
      (id: number): boolean => !hasEffectiveBlocklistIdentity(id)
    )) {
      throw new Error(
        `Pending removal row ${removalId} contains an identity absent from the effective blocklist.`
      );
    }
  }
  for (const removalId of removalSnapshot.keys()) {
    if (!next.has(removalId)) pendingRemovalWrites.set(removalId, { data: null });
  }
  for (const [removalId, pending] of next) {
    const data: string | undefined = encoded.get(removalId);
    if (data === undefined) {
      throw new Error(`Pending removal row ${removalId} is missing its encoded value.`);
    }
    if (removalSnapshotData.get(removalId) !== data) {
      pendingRemovalWrites.set(removalId, { data });
    }
    removalSnapshot.set(removalId, clonePendingRemoval(pending));
    removalSnapshotData.set(removalId, data);
  }
  for (const removalId of [...removalSnapshot.keys()]) {
    if (!next.has(removalId)) {
      removalSnapshot.delete(removalId);
      removalSnapshotData.delete(removalId);
    }
  }
  latestRemovalSnapshotRevision.current = message.revision;
  pendingRemovalSnapshotRevision.current = message.revision;
  if (pendingRemovalWrites.size === 0 && !hasPendingStorageWrites()) {
    pendingRemovalSnapshotRevision.current = null;
    reply({
      type: "identityStoragePersisted",
      writes: [],
      chatStateWrites: [],
      removalSnapshotRevision: message.revision,
    });
    return;
  }
  flushIfStorageFull(reply);
}
