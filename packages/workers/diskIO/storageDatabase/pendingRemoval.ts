import type { PendingRemovalWrite } from "../../../types/identityStorage";
import { storagePendingBudget } from "../../../cache/workers/diskIO/storageDatabase";
import { storageWriteCost } from "../../../libs/storageWriteBudget";
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
} from "../../../types/diskIO/messages";
import type {
  IdentityPersistenceReply,
} from "../../../types/diskIO/replies";
import { storageSource } from "./context";
import {
  flushIfStorageFull,
  hasPendingStorageWrites,
} from "./flush";
import {
  hasAnyEffectiveBlocklistIdentity,
  hasEffectiveBlocklistIdentity,
} from "./identityPolicy";

/**
 * 一行待踢任务的解码结果与它的落盘文本。
 *
 * 两者**必须成对**：下面每一段都要同时用到「解出来的任务」和「要写进 BLOB 的
 * 那段文本」。合成一条记录后这个配对由类型保证，取值不存在只拿到一半的形态，
 * 因此写入段无需二次查表，也没有为缺值补的不可达分支。
 */
interface EncodedPendingRemovalRow {
  readonly pending: PendingBlockedRemoval;
  readonly data: string;
}

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
  const next: Map<number, EncodedPendingRemovalRow> = new Map();
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
    next.set(removalId, { pending, data });
  }
  let hasAnyBlockedIdentity: boolean | undefined;
  for (const [removalId, { pending }] of next) {
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
  let entryDelta: number = 0;
  let byteDelta: number = 0;
  for (const removalId of removalSnapshot.keys()) {
    if (next.has(removalId)) continue;
    const previous: PendingRemovalWrite | undefined = pendingRemovalWrites.get(removalId);
    if (previous === undefined) entryDelta++;
    byteDelta += storageWriteCost(null) - (previous === undefined ? 0 : storageWriteCost(previous.data));
  }
  for (const [removalId, { data }] of next) {
    if (removalSnapshotData.get(removalId) === data) continue;
    const previous: PendingRemovalWrite | undefined = pendingRemovalWrites.get(removalId);
    if (previous === undefined) entryDelta++;
    byteDelta += storageWriteCost(data) - (previous === undefined ? 0 : storageWriteCost(previous.data));
  }
  storagePendingBudget.reserve(entryDelta, byteDelta);
  for (const removalId of removalSnapshot.keys()) {
    if (!next.has(removalId)) pendingRemovalWrites.set(removalId, { data: null });
  }
  for (const [removalId, { pending, data }] of next) {
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
      temporaryWhitelistWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
      removalSnapshotRevision: message.revision,
    });
    return;
  }
  flushIfStorageFull(reply);
}
