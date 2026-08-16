import {
  pendingBlocklistWrites,
  pendingWhitelistWrites,
} from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodeWhitelistEntryData,
} from "../../../database/codec/identity";
import {
  hasStoredIdentityPolicy,
  readStoredBlocklistIds,
  readStoredIdentityPolicies,
} from "../../../database/interact/identityPolicy";
import type {
  BlocklistIdsReadReply,
  IdentityPersistenceReply,
  IdentityPoliciesReadReply,
  IdentityPolicyWriteDiskMessage,
  ReadBlocklistIdsRequest,
  ReadIdentityPoliciesRequest,
} from "../../../types/diskIO";
import type { IdentityPolicyTable } from "../../../types/identityPolicy";
import type { PendingIdentityPolicyWrite } from "../../../types/identityStorage";
import type { StoredIdentityPolicyRow } from "../../../types/storageDatabase";
import { requireStorageDatabase, storageSource } from "./context";
import { flushIfStorageFull } from "./flush";

function pendingPolicyMap(
  table: IdentityPolicyTable
): Map<number, PendingIdentityPolicyWrite> {
  return table === "whitelist" ? pendingWhitelistWrites : pendingBlocklistWrites;
}

/** SQLite 已提交值叠加当前事务缓冲后的黑名单主键集合。 */
export function effectiveBlocklistIds(): Set<number> {
  const ids: Set<number> = new Set(readStoredBlocklistIds(requireStorageDatabase()));
  for (const [id, pending] of pendingBlocklistWrites) {
    if (pending.data === null) ids.delete(id);
    else ids.add(id);
  }
  return ids;
}

function validatePolicyData(message: IdentityPolicyWriteDiskMessage): void {
  const source: string = storageSource(`${message.table}_entries`, message.id);
  assertTelegramIdentityId(message.id, source);
  if (!Number.isSafeInteger(message.revision) || message.revision < 1) {
    throw new Error(`${source}: revision must be a positive safe integer.`);
  }
  if (message.data === null) return;
  if (message.table === "whitelist") {
    decodeWhitelistEntryData(message.data, source);
  } else {
    decodeBlocklistEntryData(message.data, source);
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
    throw new Error(
      `Identity ${message.id} cannot exist in both whitelist_entries and blocklist_entries.`
    );
  }
  if (hasStoredIdentityPolicy(requireStorageDatabase(), opposite, message.id)) {
    throw new Error(
      `Identity ${message.id} cannot exist in both whitelist_entries and blocklist_entries.`
    );
  }
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
  flushIfStorageFull(reply);
}

function policyRowsWithPending(
  table: IdentityPolicyTable,
  ids: readonly number[]
): readonly (readonly [number, string])[] {
  if (ids.length === 0) return [];
  const rows: readonly StoredIdentityPolicyRow[] = readStoredIdentityPolicies(
    requireStorageDatabase(),
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
    for (const id of ids) {
      assertTelegramIdentityId(id, `${IDENTITY_DATABASE_PATH}:readIdentityPolicies`);
    }
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
