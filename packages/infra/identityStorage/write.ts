import { assertStorageAdmission } from "../diskIO/storageAdmission";
import { canQueueDiskIOBusiness } from "../diskIO/transport";
import { storageWriteCost } from "../../libs/storageWriteBudget";
import {
  blocklistEntryCache,
  identityEntryCounts,
  identityWriteRevision,
  unacknowledgedBlocklistWrites,
  unacknowledgedIdentityWrites,
  unacknowledgedIdentityBytes,
  unacknowledgedWhitelistWrites,
  whitelistEntryCache,
} from "../../cache/main/identityStorage";
import { DISK_IO_RESPAWN_PRIORITIES } from
  "../../consts/diskIO/common";
import {
  assertTelegramIdentityId,
  encodeBlocklistEntryData,
  encodeWhitelistEntryData,
} from "../../database/codec/identity";
import { logger } from "../logger";
import { identityDiskIOApi } from "./shared";
import type {
  DiskIORecoveryTransport,
  IdentityPolicyWriteDiskMessage,
} from "../../types/diskIO/messages";
import type {
  DomainFlushOutcome,
  IdentityStoragePersistedReply,
} from "../../types/diskIO/replies";
import type {
  BlocklistEntryData,
  IdentityPolicyTable,
  WhitelistEntryData,
} from "../../types/identityPolicy";
import type { UnacknowledgedIdentityWrite } from
  "../../types/identityStorage";
import type { IdentityDiskIOApi } from "./shared";

interface QueuedIdentityWrite {
  readonly table: IdentityPolicyTable;
  readonly id: number;
  readonly change: UnacknowledgedIdentityWrite;
}

function cacheForTable(
  table: IdentityPolicyTable
): typeof whitelistEntryCache | typeof blocklistEntryCache {
  return table === "whitelist" ? whitelistEntryCache : blocklistEntryCache;
}

function oppositeCache(
  table: IdentityPolicyTable
): typeof whitelistEntryCache | typeof blocklistEntryCache {
  return table === "whitelist" ? blocklistEntryCache : whitelistEntryCache;
}

/**
 * 容量准入后发布 LRU 最终值，登记未 ACK revision 并投给 Disk I/O；迟到读不能覆盖它。
 * 调用前必须预热该 ID 的正/负结论，才能准确维护表计数与互斥边界。
 */
export function queueIdentityPolicyWrite(
  table: IdentityPolicyTable,
  id: number,
  value: Readonly<WhitelistEntryData> | Readonly<BlocklistEntryData> | null
): boolean {
  assertTelegramIdentityId(id, `identity ${table} write`);
  const cache: typeof whitelistEntryCache | typeof blocklistEntryCache =
    cacheForTable(table);
  const other: typeof whitelistEntryCache | typeof blocklistEntryCache =
    oppositeCache(table);
  if (!cache.has(id) || !other.has(id)) {
    throw new Error(`Identity ${id} must be prefetched before a ${table} mutation.`);
  }
  if (value !== null && other.peek(id) !== null) {
    throw new Error(`Identity ${id} cannot exist in both whitelist and blocklist.`);
  }
  if (!Number.isSafeInteger(identityWriteRevision.current + 1)) {
    throw new Error("Identity policy revision space is exhausted.");
  }
  const previous:
    | Readonly<WhitelistEntryData>
    | Readonly<BlocklistEntryData>
    | null
    | undefined = cache.peek(id);
  const data: string | null = value === null
    ? null
    : table === "whitelist"
      ? encodeWhitelistEntryData(value as Readonly<WhitelistEntryData>)
      : encodeBlocklistEntryData(value as Readonly<BlocklistEntryData>);
  const revision: number = identityWriteRevision.current + 1;
  const message: IdentityPolicyWriteDiskMessage = {
    type: "identityPolicyWrite",
    table,
    id,
    data,
    revision,
  };
  const pendingWrites: Map<number, UnacknowledgedIdentityWrite> = unacknowledgedIdentityWrites(table);
  const pendingPrevious: UnacknowledgedIdentityWrite | undefined = pendingWrites.get(id);
  const bytes: number = unacknowledgedIdentityBytes.current[table] + storageWriteCost(data) -
    (pendingPrevious === undefined ? 0 : storageWriteCost(pendingPrevious.data));
  assertStorageAdmission(pendingWrites.size + (pendingPrevious === undefined ? 1 : 0), bytes);
  if (!canQueueDiskIOBusiness(message)) throw new Error("Disk I/O refused identity state publication.");
  if (table === "whitelist") {
    whitelistEntryCache.set(id, value as Readonly<WhitelistEntryData> | null);
  } else {
    blocklistEntryCache.set(id, value as Readonly<BlocklistEntryData> | null);
  }
  if (previous === null && value !== null) identityEntryCounts[table]++;
  if (previous !== null && previous !== undefined && value === null) {
    identityEntryCounts[table]--;
  }
  identityWriteRevision.current++;
  pendingWrites.set(id, { data, revision });
  unacknowledgedIdentityBytes.current[table] = bytes;
  if (identityDiskIOApi.postDiskIO?.(message) === true) return true;
  logger.error(
    `Failed to queue ${table} identity ${id}; retaining revision ${revision} for replay.`
  );
  return false;
}

/**
 * 等指定身份当前未确认最终值通过 SQLite 事务并收到精确 revision ACK。
 * 幂等重试会补投先前未 ACK 的同一 revision，不创建新版本。
 */
export async function confirmIdentityPolicyPersisted(
  table: IdentityPolicyTable,
  id: number,
  retryUnacknowledged: boolean
): Promise<void> {
  assertTelegramIdentityId(id, `identity ${table} persistence confirmation`);
  const pending: UnacknowledgedIdentityWrite | undefined =
    unacknowledgedIdentityWrites(table).get(id);
  if (pending === undefined) return;
  if (retryUnacknowledged) requeueUnacknowledgedIdentityWrite(table, id);
  const flush: IdentityDiskIOApi["flushDiskIODomainOutcome"] =
    identityDiskIOApi.flushDiskIODomainOutcome;
  if (flush === undefined) {
    throw new Error(`Persistence flush is unavailable for ${table} identity ${id}.`);
  }
  const outcome: DomainFlushOutcome = await flush(table);
  if (outcome.result !== "flushed") {
    const domainNote: string = outcome.failedDomains === undefined
      ? "no per-domain reply"
      : `failed domains: ${outcome.failedDomains.join(", ")}`;
    throw new Error(
      `Persistence flush ${outcome.result} for ${table} identity ${id} revision ${pending.revision}; ${domainNote}.`
    );
  }
  if (
    unacknowledgedIdentityWrites(table).get(id)?.revision === pending.revision
  ) {
    throw new Error(
      `Persistence Worker did not acknowledge ${table} identity ${id} revision ${pending.revision}.`
    );
  }
}

/** 重投某主键仍未 ACK 的最终值；不创建新 revision。 */
export function requeueUnacknowledgedIdentityWrite(
  table: IdentityPolicyTable,
  id: number
): boolean {
  const change: UnacknowledgedIdentityWrite | undefined =
    unacknowledgedIdentityWrites(table).get(id);
  if (change === undefined) return false;
  const posted: boolean = identityDiskIOApi.postDiskIO?.({
    type: "identityPolicyWrite",
    table,
    id,
    data: change.data,
    revision: change.revision,
  } satisfies IdentityPolicyWriteDiskMessage) === true;
  if (!posted) {
    logger.error(
      `Failed to re-queue ${table} identity ${id} revision ${change.revision}.`
    );
  }
  return true;
}

function settleIdentityStorageWrite(
  reply: IdentityStoragePersistedReply
): void {
  for (const persisted of reply.writes) {
    const pending: Map<number, UnacknowledgedIdentityWrite> =
      unacknowledgedIdentityWrites(persisted.table);
    const change: UnacknowledgedIdentityWrite | undefined = pending.get(persisted.id);
    if (change?.revision === persisted.revision) {
      pending.delete(persisted.id);
      unacknowledgedIdentityBytes.current[persisted.table] -= storageWriteCost(change.data);
    }
  }
}

function replayIdentityPolicyWrites(
  transport: DiskIORecoveryTransport
): boolean {
  const tables: readonly (readonly [
    IdentityPolicyTable,
    Map<number, UnacknowledgedIdentityWrite>
  ])[] = [
    ["whitelist", unacknowledgedWhitelistWrites],
    ["blocklist", unacknowledgedBlocklistWrites],
  ];
  const queued: QueuedIdentityWrite[] = [];
  for (const [table, writes] of tables) {
    for (const [id, change] of writes) queued.push({ table, id, change });
  }
  queued.sort(
    (left: QueuedIdentityWrite, right: QueuedIdentityWrite): number =>
      left.change.revision - right.change.revision
  );
  for (const write of queued) {
    if (!transport.post({
      type: "identityPolicyWrite",
      table: write.table,
      id: write.id,
      data: write.change.data,
      revision: write.change.revision,
    } satisfies IdentityPolicyWriteDiskMessage)) return false;
  }
  return true;
}

if (identityDiskIOApi.onIdentityStoragePersisted !== undefined) {
  identityDiskIOApi.onIdentityStoragePersisted(settleIdentityStorageWrite);
}
if (identityDiskIOApi.onDiskIORespawn !== undefined) {
  identityDiskIOApi.onDiskIORespawn(
    "identity policies",
    DISK_IO_RESPAWN_PRIORITIES.BLOCKLIST,
    replayIdentityPolicyWrites
  );
}
