import { readStoredAiContexts } from "./aiContext";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../../consts/identityStorage";
import {
  BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE,
  BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES,
} from "../../consts/antiRaid/blocklist";
import {
  assertStorageDatabaseIntegrity,
  assertStorageDatabaseJsonbStorage,
  assertStorageDatabaseMigrationLineage,
  assertStorageDatabaseStartupJsonbStorage,
  assertStoredIdentityPolicies,
  readStorageDatabasePendingRemovalPage,
  readStorageDatabaseSchemaMetadata,
  readStorageDatabaseStartupRows,
} from "./inspection";
import {
  assertPendingRemovalBlocklistReferences,
  decodeStoredChatStates,
  decodeStoredPendingRemovals,
  readStorageSchemaVersion,
  decodeStoredChatQa,
} from "../validation/storageRows";
import type { ChatState } from "../../types/chatState";
import type { PendingBlockedRemoval } from "../../types/blocklist";
import type { DecodedPendingRemovalRows } from
  "../validation/storageRows";
import type {
  StorageDatabase,
  StorageDatabaseStartupRows,
  StoredPendingRemovalRow,
  StoredPendingRemovalStartupRow,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";
import type { StorageDatabaseInspection } from "../../types/identityStorage";

type ValidatedPendingRemovalStartupRow =
  StoredPendingRemovalStartupRow & StoredPendingRemovalRow;

/** 校验分页存储形态并把 nullable 投影收窄为领域解码器接受的规范文本。 */
function assertPendingRemovalPage(
  rows: readonly StoredPendingRemovalStartupRow[],
  source: string
): asserts rows is readonly ValidatedPendingRemovalStartupRow[] {
  for (const row of rows) {
    if (row.storageClass !== "blob" || row.data === null) {
      throw new Error(
        `${source}:pending_blocked_removals[${row.removalId}].data: ` +
        "expected a BLOB containing strict SQLite JSONB."
      );
    }
  }
}

interface PendingRemovalInspection {
  readonly values: Map<number, PendingBlockedRemoval>;
  readonly encoded: Map<number, string>;
}

/**
 * 一页完成存储形态与领域解码后才推进游标；失败由外层统一丢弃半恢复快照。
 * 累计行数超过 `BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES` 时在解码该页之前拒绝启动，
 * 主线程 `hydrateBlocklist` 只接收本处校验过的快照，不再重复判定。
 */
function inspectPendingRemovalPages(
  database: StorageDatabase,
  source: string
): PendingRemovalInspection {
  const values: Map<number, PendingBlockedRemoval> = new Map();
  const encoded: Map<number, string> = new Map();
  let afterRemovalId: number | null = null;
  while (true) {
    const page: readonly StoredPendingRemovalStartupRow[] =
      readStorageDatabasePendingRemovalPage(database, afterRemovalId);
    if (values.size + page.length > BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES) {
      throw new Error(
        `${source}:pending_blocked_removals: ` +
        `expected at most ${BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES} rows.`
      );
    }
    assertPendingRemovalPage(page, source);
    const removals: DecodedPendingRemovalRows = decodeStoredPendingRemovals(
      page,
      source
    );
    for (const [removalId, pending] of removals.values) {
      values.set(removalId, pending);
    }
    for (const [removalId, data] of removals.encoded) {
      encoded.set(removalId, data);
    }
    if (page.length < BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE) {
      return { values, encoded };
    }
    const last: StoredPendingRemovalStartupRow | undefined = page.at(-1);
    if (last === undefined) return { values, encoded };
    afterRemovalId = last.removalId;
  }
}

/** 启动与冷迁移共用的完整只读校验；连接与快照生命周期由调用方持有。 */
export function validateStorageDatabase(database: StorageDatabase, source: string): StorageDatabaseInspection {
  assertStorageDatabaseStartupJsonbStorage(database, source);
  // 版本判定必须排在读取业务行**之前**：当前 schema 才保证所有业务表存在，
  // 先读 startup rows 会把版本不符伪装成 SQLite 缺表错误。
  const metadata: readonly StoredStorageMetadataRow[] =
    readStorageDatabaseSchemaMetadata(database);
  const version: number = readStorageSchemaVersion(
    { metadata },
    source
  );
  if (version !== IDENTITY_DATABASE_SCHEMA_VERSION) {
    throw new Error(
      source + ": storage_metadata schema-version must be " +
      "{\"version\":" + String(IDENTITY_DATABASE_SCHEMA_VERSION) + "}."
    );
  }
  assertStorageDatabaseIntegrity(database, source);
  assertStorageDatabaseMigrationLineage(database, source);
  assertStorageDatabaseJsonbStorage(database, source);
  assertStoredIdentityPolicies(database, source);
  const rows: StorageDatabaseStartupRows = readStorageDatabaseStartupRows(database);
  const removals: PendingRemovalInspection = inspectPendingRemovalPages(database, source);
  const chatStates: Map<number, ChatState> = decodeStoredChatStates(
    rows.chatStates,
    source
  );
  assertPendingRemovalBlocklistReferences(
    database,
    removals.values,
    source
  );
  // 群状态与问答沿用同一连接的启动读取边界；本函数不打开连接或发布缓存。
  const chatQaEntries: Map<number, ReadonlyMap<string, string>> = new Map(
    decodeStoredChatQa(rows.chatQa, source)
  );
  return {
    hydration: {
      blocklistEntryCount: rows.blocklistEntryCount,
      permissionEntryCount: rows.permissionEntryCount,
      pendingBlockedRemovals: removals.values,
      chatStates,
      chatQa: chatQaEntries,
    },
    pendingRemovalData: removals.encoded,
    aiMemories: readStoredAiContexts(database, source),
  };
}
