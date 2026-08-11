/**
 * 黑名单、白名单与待踢成员 SQLite 的唯一 owner。
 *
 * SQLite/Drizzle 操作统一经 database/interact，建表 migration 位于 database/schema。
 * 三张业务表的待写主键分别计数，任一达到 128 条或首条变化等待 30 秒后，用同
 * 一个显式事务提交当时全部变化。事务失败不会清缓冲，下一轮 timer 与统一 flush
 * 都会重试。
 */

import {
  identityDatabaseHandle,
  identityPersistenceReplyHolder,
  identityWriteFlushTimer,
  latestRemovalSnapshotRevision,
  pendingBlocklistWrites,
  pendingRemovalSnapshotRevision,
  pendingRemovalWrites,
  pendingWhitelistWrites,
  rejectedIdentityDomains,
  removalSnapshot,
  removalSnapshotData,
  resetIdentityDatabaseCache,
} from "../../cache/workers/diskIO/identityDatabase";
import {
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_DATABASE_SCHEMA_VERSION,
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
  IDENTITY_WRITE_FLUSH_INTERVAL_MS,
} from "../../consts/identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../consts/paths";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodePendingBlockedRemovalData,
  decodeWhitelistEntryData,
  encodePendingBlockedRemovalData,
} from "../../database/codec/identity";
import type { EncodedPendingBlockedRemoval } from "../../database/codec/identity";
import {
  assertIdentityDatabaseIntegrity,
  assertIdentityDatabaseJsonbStorage,
  commitIdentityDatabaseChanges,
  hasStoredIdentityPolicy,
  openIdentityDatabase,
  readIdentityDatabaseRows,
  readStoredBlocklistIds,
  readStoredIdentityPolicies,
} from "../../database/interact/identity";
import { parseJsonInput } from "../../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import type {
  IdentityDatabase,
  IdentityDatabaseRows,
  StoredIdentityMetadataRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
} from "../../types/identityDatabase";
import type { PendingBlockedRemoval } from "../../types/blocklist";
import type {
  BlocklistIdsReadReply,
  BlocklistRemovalsDiskMessage,
  IdentityPersistenceReply,
  IdentityPoliciesReadReply,
  IdentityPolicyPersistedRevision,
  IdentityPolicyWriteDiskMessage,
  ReadBlocklistIdsRequest,
  ReadIdentityPoliciesRequest,
} from "../../types/diskIO";
import type {
  IdentityDatabaseHydration,
  PendingIdentityPolicyWrite,
  PendingRemovalWrite,
} from "../../types/identityStorage";
import type { IdentityPolicyTable } from "../../types/identityPolicy";

function requireDatabase(): IdentityDatabase {
  const database: IdentityDatabase | null = identityDatabaseHandle.current;
  if (database === null) {
    throw new Error(`${IDENTITY_DATABASE_PATH}: database must be loaded before use.`);
  }
  return database;
}

function source(table: string, id: number | string): string {
  return `${IDENTITY_DATABASE_PATH}:${table}[${String(id)}].data`;
}

function parseSchemaVersion(text: string): void {
  const parsed: unknown = parseJsonInput(
    text,
    `${IDENTITY_DATABASE_PATH}:storage_metadata[schema-version].data`
  );
  if (
    !isPlainRecord(parsed) ||
    !hasExactKeys(parsed, ["version"]) ||
    parsed.version !== IDENTITY_DATABASE_SCHEMA_VERSION
  ) {
    throw new Error(
      `${IDENTITY_DATABASE_PATH}: storage_metadata schema-version must be {"version":${IDENTITY_DATABASE_SCHEMA_VERSION}}.`
    );
  }
}

/** 打开并全表严格校验；黑白名单只返回计数，主线程不会恢复无界 Map。 */
export function hydrateIdentityDatabase(): IdentityDatabaseHydration {
  resetIdentityDatabaseCache();
  const database: IdentityDatabase = openIdentityDatabase({
    path: IDENTITY_DATABASE_PATH,
    requireWritableAccess: true,
  });
  identityDatabaseHandle.current = database;
  try {
    assertIdentityDatabaseIntegrity(database);
    assertIdentityDatabaseJsonbStorage(database, IDENTITY_DATABASE_PATH);
    const rows: IdentityDatabaseRows = readIdentityDatabaseRows(database);
    if (
      rows.metadata.length !== 1 ||
      rows.metadata[0]?.key !== IDENTITY_DATABASE_SCHEMA_KEY
    ) {
      throw new Error(`${IDENTITY_DATABASE_PATH}: storage_metadata must contain exactly one schema-version row.`);
    }
    const metadataRow: StoredIdentityMetadataRow = rows.metadata[0];
    parseSchemaVersion(metadataRow.data);

    const whitelistRows: readonly StoredIdentityPolicyRow[] = rows.whitelist;
    const blocklistRows: readonly StoredIdentityPolicyRow[] = rows.blocklist;
    const whitelistIds: Set<number> = new Set();
    const blocklistIds: Set<number> = new Set();
    for (const row of whitelistRows) {
      assertTelegramIdentityId(row.id, source("whitelist_entries", row.id));
      decodeWhitelistEntryData(row.data, source("whitelist_entries", row.id));
      whitelistIds.add(row.id);
    }
    for (const row of blocklistRows) {
      assertTelegramIdentityId(row.id, source("blocklist_entries", row.id));
      decodeBlocklistEntryData(row.data, source("blocklist_entries", row.id));
      if (whitelistIds.has(row.id)) {
        throw new Error(`${IDENTITY_DATABASE_PATH}: identity ${row.id} exists in both whitelist_entries and blocklist_entries.`);
      }
      blocklistIds.add(row.id);
    }

    const outboxRows: readonly StoredPendingRemovalRow[] = rows.removals;
    for (const row of outboxRows) {
      if (!Number.isSafeInteger(row.removalId) || row.removalId < 1) {
        throw new Error(`${source("pending_blocked_removals", row.removalId)}: removal_id must be a positive safe integer.`);
      }
      const pending: PendingBlockedRemoval = decodePendingBlockedRemovalData(
        row.data,
        source("pending_blocked_removals", row.removalId)
      );
      if (pending.params.removalId !== row.removalId) {
        throw new Error(`${source("pending_blocked_removals", row.removalId)}: params.removalId must equal the row primary key.`);
      }
      if (pending.params.probeMembership) {
        if (blocklistIds.size === 0) {
          throw new Error(`${source("pending_blocked_removals", row.removalId)}: sweep requires at least one blocklist entry.`);
        }
      } else if (pending.params.userIds.some(
        (id: number): boolean => !blocklistIds.has(id)
      )) {
        throw new Error(`${source("pending_blocked_removals", row.removalId)}: frozen userIds must all exist in blocklist_entries.`);
      }
      removalSnapshot.set(row.removalId, pending);
      // 存规范化文本而不是 row.data：变更比较的口径必须与写入侧一致，手工编辑
      // 过缩进的行才不会被判成「没变」而永远留着非规范格式。
      removalSnapshotData.set(
        row.removalId,
        encodePendingBlockedRemovalData(
          pending,
          source("pending_blocked_removals", row.removalId)
        ).text
      );
    }
    return {
      blocklistEntryCount: blocklistRows.length,
      whitelistEntryCount: whitelistRows.length,
      pendingBlockedRemovals: new Map(removalSnapshot),
    };
  } catch (error: unknown) {
    resetIdentityDatabaseCache();
    throw error;
  }
}

function pendingPolicyMap(
  table: IdentityPolicyTable
): Map<number, PendingIdentityPolicyWrite> {
  return table === "whitelist" ? pendingWhitelistWrites : pendingBlocklistWrites;
}

/** SQLite 已提交值叠加当前事务缓冲后的黑名单主键集合。 */
function effectiveBlocklistIds(): Set<number> {
  const ids: Set<number> = new Set(readStoredBlocklistIds(requireDatabase()));
  for (const [id, pending] of pendingBlocklistWrites) {
    if (pending.data === null) ids.delete(id);
    else ids.add(id);
  }
  return ids;
}

function validatePolicyData(message: IdentityPolicyWriteDiskMessage): void {
  assertTelegramIdentityId(message.id, source(`${message.table}_entries`, message.id));
  if (!Number.isSafeInteger(message.revision) || message.revision < 1) {
    throw new Error(`${source(`${message.table}_entries`, message.id)}: revision must be a positive safe integer.`);
  }
  if (message.data === null) return;
  if (message.table === "whitelist") {
    decodeWhitelistEntryData(message.data, source("whitelist_entries", message.id));
  } else {
    decodeBlocklistEntryData(message.data, source("blocklist_entries", message.id));
  }
}

function assertOppositePolicyAbsent(message: IdentityPolicyWriteDiskMessage): void {
  if (message.data === null) return;
  const opposite: IdentityPolicyTable = message.table === "whitelist"
    ? "blocklist"
    : "whitelist";
  const pending: PendingIdentityPolicyWrite | undefined =
    pendingPolicyMap(opposite).get(message.id);
  if (pending !== undefined) {
    if (pending.data === null) return;
    throw new Error(`Identity ${message.id} cannot exist in both whitelist_entries and blocklist_entries.`);
  }
  if (hasStoredIdentityPolicy(requireDatabase(), opposite, message.id)) {
    throw new Error(`Identity ${message.id} cannot exist in both whitelist_entries and blocklist_entries.`);
  }
}

function hasPendingWrites(): boolean {
  return pendingWhitelistWrites.size > 0 ||
    pendingBlocklistWrites.size > 0 ||
    pendingRemovalWrites.size > 0;
}

function armFlushTimer(): void {
  if (!hasPendingWrites() || identityWriteFlushTimer.current !== null) return;
  identityWriteFlushTimer.current = setTimeout((): void => {
    identityWriteFlushTimer.current = null;
    const reply: IdentityPersistenceReply | null = identityPersistenceReplyHolder.current;
    if (reply === null) {
      console.error("[diskIOWorker] identity database flush reply channel is unavailable.");
      armFlushTimer();
      return;
    }
    if (!flushIdentityDatabase(reply)) {
      console.error("[diskIOWorker] failed to flush the identity database; retaining pending changes for retry.");
      armFlushTimer();
    }
  }, IDENTITY_WRITE_FLUSH_INTERVAL_MS);
  identityWriteFlushTimer.current.unref();
}

function flushIfFull(reply: IdentityPersistenceReply): void {
  if (
    pendingWhitelistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingBlocklistWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES ||
    pendingRemovalWrites.size >= IDENTITY_WRITE_BATCH_MAX_ENTRIES
  ) {
    if (!flushIdentityDatabase(reply)) armFlushTimer();
    return;
  }
  armFlushTimer();
}

/** 收下一条黑/白名单最终值；迟到 revision 不得覆盖更新值。 */
export function handleIdentityPolicyWrite(
  message: IdentityPolicyWriteDiskMessage,
  reply: IdentityPersistenceReply
): void {
  validatePolicyData(message);
  const pending: Map<number, PendingIdentityPolicyWrite> = pendingPolicyMap(message.table);
  const current: PendingIdentityPolicyWrite | undefined = pending.get(message.id);
  if (current !== undefined && current.revision >= message.revision) return;
  assertOppositePolicyAbsent(message);
  pending.set(message.id, { data: message.data, revision: message.revision });
  flushIfFull(reply);
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
  const next: Map<number, PendingBlockedRemoval> = new Map();
  const encoded: Map<number, string> = new Map();
  for (const [removalId, raw] of message.removals) {
    if (next.has(removalId)) {
      throw new Error(`Pending removal snapshot contains duplicate removalId ${removalId}.`);
    }
    // 编码器把校验时解出的规范值一并交回来；再 decode 一次只是把同一段 JSON
    // 重新 parse 加全量校验，每条持久化条目白付一遍。
    const { text: data, value: pending }: EncodedPendingBlockedRemoval =
      encodePendingBlockedRemovalData(
        raw,
        source("pending_blocked_removals", removalId)
      );
    if (pending.params.removalId !== removalId) {
      throw new Error(`Pending removal row ${removalId} does not match params.removalId.`);
    }
    next.set(removalId, pending);
    encoded.set(removalId, data);
  }
  const blockedIds: Set<number> = effectiveBlocklistIds();
  for (const [removalId, pending] of next) {
    if (pending.params.probeMembership) {
      if (blockedIds.size === 0) {
        throw new Error(`Pending removal row ${removalId} requires at least one effective blocklist entry.`);
      }
      continue;
    }
    if (pending.params.userIds.some((id: number): boolean => !blockedIds.has(id))) {
      throw new Error(`Pending removal row ${removalId} contains an identity absent from the effective blocklist.`);
    }
  }
  for (const removalId of removalSnapshot.keys()) {
    if (!next.has(removalId)) pendingRemovalWrites.set(removalId, { data: null });
  }
  for (const [removalId, pending] of next) {
    const data: string = encoded.get(removalId)!;
    // 与**上一次已编码文本**比，而不是把已存储的规范值重新 encode 一遍：后者要
    // 对每条已存 removal 再付一次 stringify + parse + 全量校验，只为得出「没变」。
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
  if (pendingRemovalWrites.size === 0 && !hasPendingWrites()) {
    pendingRemovalSnapshotRevision.current = null;
    reply({ type: "identityStoragePersisted", writes: [], removalSnapshotRevision: message.revision });
    return;
  }
  flushIfFull(reply);
}

/**
 * 当前三表待写值在一个显式事务中提交；成功后才清缓冲并回 ACK。
 * @returns true 表示本轮全部变化已 durable 或本来无变化。
 */
export function flushIdentityDatabase(reply: IdentityPersistenceReply): boolean {
  // 被拒收的消息不会自己出现在待写缓冲里，但那条最终值确实没落盘；本轮必须
  // 按失败结算，否则 /block 的 confirmBlocklistPersisted 会把「Worker 丢掉了
  // 这条消息」读成「已经写进硬盘」。
  const rejected: boolean = rejectedIdentityDomains.size > 0;
  if (!hasPendingWrites()) {
    const removalRevision: number | null = pendingRemovalSnapshotRevision.current;
    if (removalRevision !== null) {
      pendingRemovalSnapshotRevision.current = null;
      reply({ type: "identityStoragePersisted", writes: [], removalSnapshotRevision: removalRevision });
    }
    return !rejected;
  }
  if (identityWriteFlushTimer.current !== null) {
    clearTimeout(identityWriteFlushTimer.current);
    identityWriteFlushTimer.current = null;
  }
  const whitelist: Map<number, PendingIdentityPolicyWrite> = new Map(pendingWhitelistWrites);
  const blocklist: Map<number, PendingIdentityPolicyWrite> = new Map(pendingBlocklistWrites);
  const removals: Map<number, PendingRemovalWrite> = new Map(pendingRemovalWrites);
  const removalRevision: number | null = pendingRemovalSnapshotRevision.current;
  try {
    commitIdentityDatabaseChanges(requireDatabase(), {
      whitelist,
      blocklist,
      removals,
    });
  } catch (error: unknown) {
    console.error("[diskIOWorker] identity database transaction failed:", error);
    armFlushTimer();
    return false;
  }
  const acknowledgements: IdentityPolicyPersistedRevision[] = [];
  for (const [id, change] of whitelist) {
    if (pendingWhitelistWrites.get(id) === change) pendingWhitelistWrites.delete(id);
    acknowledgements.push({ table: "whitelist", id, revision: change.revision });
  }
  for (const [id, change] of blocklist) {
    if (pendingBlocklistWrites.get(id) === change) pendingBlocklistWrites.delete(id);
    acknowledgements.push({ table: "blocklist", id, revision: change.revision });
  }
  for (const [id, change] of removals) {
    if (pendingRemovalWrites.get(id) === change) pendingRemovalWrites.delete(id);
  }
  if (pendingRemovalSnapshotRevision.current === removalRevision) {
    pendingRemovalSnapshotRevision.current = null;
  }
  reply({
    type: "identityStoragePersisted",
    writes: acknowledgements,
    ...(removalRevision === null ? {} : { removalSnapshotRevision: removalRevision }),
  });
  armFlushTimer();
  return !rejected;
}

/**
 * 查询失败领域仅按本轮仍 dirty 的表报告，避免 /block 被白名单故障误导。
 *
 * 同时**取走并清空**拒收标记：那些消息已经不在任何缓冲里，只有这一次能说出口；
 * 不清空的话一次校验失败会让此后每一轮 flush 都永久回报同一个领域失败。
 */
export function pendingIdentityDatabaseDomains(): readonly (
  "whitelist" | "blocklist" | "blocklistRemovalOutbox"
)[] {
  const domains: Set<"whitelist" | "blocklist" | "blocklistRemovalOutbox"> =
    new Set(rejectedIdentityDomains);
  rejectedIdentityDomains.clear();
  if (pendingWhitelistWrites.size > 0) domains.add("whitelist");
  if (pendingBlocklistWrites.size > 0) domains.add("blocklist");
  if (pendingRemovalWrites.size > 0) domains.add("blocklistRemovalOutbox");
  return [...domains];
}

function policyRowsWithPending(
  table: IdentityPolicyTable,
  ids: readonly number[]
): readonly (readonly [number, string])[] {
  if (ids.length === 0) return [];
  const rows: readonly StoredIdentityPolicyRow[] = readStoredIdentityPolicies(
    requireDatabase(),
    table,
    ids
  );
  const values: Map<number, string> = new Map();
  for (const row of rows) values.set(row.id, row.data);
  for (const id of ids) {
    const pending: PendingIdentityPolicyWrite | undefined = pendingPolicyMap(table).get(id);
    if (pending === undefined) continue;
    if (pending.data === null) values.delete(id);
    else values.set(id, pending.data);
  }
  return [...values];
}

/** 批量读取两表；结果包含 Worker 尚未提交的最终值。 */
export function readIdentityPolicies(
  message: ReadIdentityPoliciesRequest
): IdentityPoliciesReadReply {
  try {
    const ids: number[] = [...new Set<number>(message.ids)];
    for (const id of ids) assertTelegramIdentityId(id, `${IDENTITY_DATABASE_PATH}:readIdentityPolicies`);
    return {
      type: "identityPoliciesRead",
      requestId: message.requestId,
      whitelist: policyRowsWithPending("whitelist", ids),
      blocklist: policyRowsWithPending("blocklist", ids),
    };
  } catch (error: unknown) {
    return {
      type: "identityPoliciesRead",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 读取完整黑名单主键集合并叠加尚未提交的最终值；只在群级补扫边界调用。 */
export function readBlocklistIds(
  message: ReadBlocklistIdsRequest
): BlocklistIdsReadReply {
  try {
    const ids: Set<number> = effectiveBlocklistIds();
    return { type: "blocklistIdsRead", requestId: message.requestId, ids: [...ids] };
  } catch (error: unknown) {
    return {
      type: "blocklistIdsRead",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Worker 启动时安装事务 ACK 通道，供 30 秒 timer 复用。 */
export function configureIdentityPersistenceReply(
  reply: IdentityPersistenceReply
): void {
  identityPersistenceReplyHolder.current = reply;
}
