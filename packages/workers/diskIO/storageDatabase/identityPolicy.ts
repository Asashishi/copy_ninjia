import {
  BLOCKLIST_SWEEP_PAGE_SIZE,
  BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES,
} from "../../../consts/identityStorage";
import {
  pendingBlocklistWrites,
  pendingWhitelistWrites,
  storedIdentityIdLookups,
} from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodeWhitelistEntryData,
} from "../../../database/codec/identity";
import {
  prepareStoredIdentityIdLookups,
  readStoredBlocklistIdPage,
  readStoredIdentityPolicies,
} from "../../../database/interact/identityPolicy";
import type {
  BlocklistIdPageReadReply,
  IdentityPersistenceReply,
  IdentityPoliciesReadReply,
} from "../../../types/diskIO/replies";
import type {
  IdentityPolicyWriteDiskMessage,
  ReadBlocklistIdPageRequest,
  ReadIdentityPoliciesRequest,
} from "../../../types/diskIO/messages";
import type { IdentityPolicyTable } from "../../../types/identityPolicy";
import type { PendingIdentityPolicyWrite } from "../../../types/identityStorage";
import type {
  StorageDatabase,
  StoredIdentityIdLookup,
  StoredIdentityIdLookups,
  StoredIdentityPolicyRow,
} from "../../../types/storageDatabase";
import type { BlocklistIdPage } from "../../../types/identityStorage";
import { requireStorageDatabase, storageSource } from "./context";
import { flushIfStorageFull } from "./flush";

/**
 * 取本连接的两条预编译语句，首次用到时建好挂进连接级缓存。
 *
 * 缓存住在这里而不是 database/interact：那一层是不接触任何线程独占缓存的叶子
 * 模块（AGENTS.md 的分层约定），而这两条语句只有本 Worker 用。
 */
function identityIdLookups(): StoredIdentityIdLookups {
  const database: StorageDatabase = requireStorageDatabase();
  const cached: StoredIdentityIdLookups | undefined =
    storedIdentityIdLookups.get(database);
  if (cached !== undefined) return cached;
  const lookups: StoredIdentityIdLookups =
    prepareStoredIdentityIdLookups(database);
  storedIdentityIdLookups.set(database, lookups);
  return lookups;
}

/** 某名单主键是否已经持久化；走本连接的预编译语句，不现场拼 SQL。 */
function hasStoredIdentityPolicy(table: IdentityPolicyTable, id: number): boolean {
  const lookups: StoredIdentityIdLookups = identityIdLookups();
  const lookup: StoredIdentityIdLookup =
    table === "whitelist" ? lookups.whitelist : lookups.blocklist;
  return lookup.get({ id }) !== undefined;
}

function pendingPolicyMap(
  table: IdentityPolicyTable
): Map<number, PendingIdentityPolicyWrite> {
  return table === "whitelist" ? pendingWhitelistWrites : pendingBlocklistWrites;
}

/**
 * SQLite 已提交游标页叠加事务内最终值；候选集合严格受「页 + pending 硬顶」约束。
 * 补扫每页前会先 flush，这个合并只处理 flush 回执后并发到达的短窗口变化。
 */
function effectiveBlocklistIdPage(afterId: number | null): BlocklistIdPage {
  if (
    pendingBlocklistWrites.size >
    BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES
  ) {
    throw new Error(
      `Pending blocklist delta exceeds ${BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES} entries; ` +
      "refusing to expand a sweep page."
    );
  }
  const readLimit: number = BLOCKLIST_SWEEP_PAGE_SIZE +
    pendingBlocklistWrites.size + 1;
  const storedIds: readonly number[] = readStoredBlocklistIdPage(
    requireStorageDatabase(),
    afterId,
    readLimit
  );
  const candidates: Set<number> = new Set<number>();
  for (const id of storedIds) {
    if (pendingBlocklistWrites.get(id)?.data !== null) candidates.add(id);
  }
  for (const [id, pending] of pendingBlocklistWrites) {
    if (
      pending.data !== null &&
      (afterId === null || id > afterId)
    ) {
      candidates.add(id);
    }
  }
  const ordered: number[] = [...candidates];
  ordered.sort((left: number, right: number): number => left - right);
  const done: boolean = ordered.length <= BLOCKLIST_SWEEP_PAGE_SIZE;
  const ids: number[] = done
    ? ordered
    : ordered.slice(0, BLOCKLIST_SWEEP_PAGE_SIZE);
  return {
    ids,
    nextCursor: ids.length === 0 ? afterId : ids[ids.length - 1]!,
    done,
  };
}

/** outbox 严格校验一个冻结目标是否仍属于事务叠加后的黑名单。 */
export function hasEffectiveBlocklistIdentity(id: number): boolean {
  const pending: PendingIdentityPolicyWrite | undefined =
    pendingBlocklistWrites.get(id);
  if (pending !== undefined) return pending.data !== null;
  return hasStoredIdentityPolicy("blocklist", id);
}

/** outbox 的 probe 任务是否仍至少有一个目标；只读取第一张有界游标页。 */
export function hasAnyEffectiveBlocklistIdentity(): boolean {
  return effectiveBlocklistIdPage(null).ids.length > 0;
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
  if (hasStoredIdentityPolicy(opposite, message.id)) {
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

/** 读取一页有界黑名单主键并叠加尚未提交的最终值；只在群级补扫边界调用。 */
export function readBlocklistIdPage(
  message: ReadBlocklistIdPageRequest
): BlocklistIdPageReadReply {
  try {
    if (message.afterId !== null) {
      assertTelegramIdentityId(
        message.afterId,
        `${IDENTITY_DATABASE_PATH}:readBlocklistIdPage.afterId`
      );
    }
    return {
      type: "blocklistIdPageRead",
      requestId: message.requestId,
      page: effectiveBlocklistIdPage(message.afterId),
    };
  } catch (error: unknown) {
    return {
      type: "blocklistIdPageRead",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
