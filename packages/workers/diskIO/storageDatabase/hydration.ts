import {
  removalSnapshot,
  removalSnapshotData,
  resetStorageDatabaseCache,
  storageDatabaseHandle,
} from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../../../consts/identityStorage";
import { BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE } from
  "../../../consts/antiRaid/blocklist";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../database/interact/connection";
import {
  assertStorageDatabaseIntegrity,
  assertStorageDatabaseJsonbStorage,
  assertStorageDatabaseMigrationLineage,
  assertStorageDatabaseStartupJsonbStorage,
  assertStoredIdentityPolicies,
  readStorageDatabasePendingRemovalPage,
  readStorageDatabaseSchemaMetadata,
  readStorageDatabaseStartupRows,
} from "../../../database/interact/inspection";
import {
  assertPendingRemovalBlocklistReferences,
  decodeStoredChatStates,
  decodeStoredPendingRemovals,
  readStorageSchemaVersion,
  decodeStoredChatQa,
} from "../../../database/validation/storageRows";
import type { ChatState } from "../../../types/chatState";
import type { PendingBlockedRemoval } from "../../../types/blocklist";
import type { DecodedPendingRemovalRows } from
  "../../../database/validation/storageRows";
import type {
  StorageDatabase,
  StorageDatabaseStartupRows,
  StoredPendingRemovalRow,
  StoredPendingRemovalStartupRow,
  StoredStorageMetadataRow,
} from "../../../types/storageDatabase";
import type { StorageDatabaseHydration } from "../../../types/identityStorage";

type ValidatedPendingRemovalStartupRow =
  StoredPendingRemovalStartupRow & StoredPendingRemovalRow;

/** 校验分页存储形态并把 nullable 投影收窄为领域解码器接受的规范文本。 */
function assertPendingRemovalPage(
  rows: readonly StoredPendingRemovalStartupRow[]
): asserts rows is readonly ValidatedPendingRemovalStartupRow[] {
  for (const row of rows) {
    if (row.storageClass !== "blob" || row.data === null) {
      throw new Error(
        `${IDENTITY_DATABASE_PATH}:pending_blocked_removals[${row.removalId}].data: ` +
        "expected a BLOB containing strict SQLite JSONB."
      );
    }
  }
}

/** 一页完成存储形态与领域解码后才推进游标；失败由外层统一丢弃半恢复快照。 */
interface PendingRemovalInspection {
  readonly values: Map<number, PendingBlockedRemoval>;
  readonly encoded: Map<number, string>;
}

function inspectPendingRemovalPages(
  database: StorageDatabase
): PendingRemovalInspection {
  const values: Map<number, PendingBlockedRemoval> = new Map();
  const encoded: Map<number, string> = new Map();
  let afterRemovalId: number | null = null;
  while (true) {
    const page: readonly StoredPendingRemovalStartupRow[] =
      readStorageDatabasePendingRemovalPage(database, afterRemovalId);
    assertPendingRemovalPage(page);
    const removals: DecodedPendingRemovalRows = decodeStoredPendingRemovals(
      page,
      IDENTITY_DATABASE_PATH
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

export interface StorageDatabaseInspection {
  readonly hydration: StorageDatabaseHydration;
  readonly pendingRemovalData: ReadonlyMap<number, string>;
}

/** 跨域启动第一阶段：以只读连接严格校验并重建有限快照。 */
export function inspectStorageDatabase(): StorageDatabaseInspection {
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
    readonly: true,
    requireWritableAccess: true,
  });
  try {
    assertStorageDatabaseStartupJsonbStorage(database, IDENTITY_DATABASE_PATH);
    // 版本判定必须排在读取业务行**之前**：当前 schema 才保证所有业务表存在，
    // 先读 startup rows 会把版本不符伪装成 SQLite 缺表错误。
    const metadata: readonly StoredStorageMetadataRow[] =
      readStorageDatabaseSchemaMetadata(database);
    const version: number = readStorageSchemaVersion(
      { metadata },
      IDENTITY_DATABASE_PATH
    );
    if (version !== IDENTITY_DATABASE_SCHEMA_VERSION) {
      throw new Error(
        IDENTITY_DATABASE_PATH + ": storage_metadata schema-version must be " +
        "{\"version\":" + String(IDENTITY_DATABASE_SCHEMA_VERSION) + "}."
      );
    }
    assertStorageDatabaseIntegrity(database, IDENTITY_DATABASE_PATH);
    assertStorageDatabaseMigrationLineage(database, IDENTITY_DATABASE_PATH);
    assertStorageDatabaseJsonbStorage(database, IDENTITY_DATABASE_PATH);
    assertStoredIdentityPolicies(database, IDENTITY_DATABASE_PATH);
    const rows: StorageDatabaseStartupRows = readStorageDatabaseStartupRows(database);
    const removals: PendingRemovalInspection = inspectPendingRemovalPages(database);
    const chatStates: Map<number, ChatState> = decodeStoredChatStates(
      rows.chatStates,
      IDENTITY_DATABASE_PATH
    );
    assertPendingRemovalBlocklistReferences(
      database,
      removals.values,
      IDENTITY_DATABASE_PATH
    );
    // 问答与群状态同一次事务读出，因此这里拿到的是同一时点的快照。
    const chatQaEntries: Map<number, ReadonlyMap<string, string>> = new Map(
      decodeStoredChatQa(rows.chatQa, IDENTITY_DATABASE_PATH)
    );
    return {
      hydration: {
        blocklistEntryCount: rows.blocklistEntryCount,
        whitelistEntryCount: rows.whitelistEntryCount,
        pendingBlockedRemovals: removals.values,
        chatStates,
        chatQa: chatQaEntries,
      },
      pendingRemovalData: removals.encoded,
    };
  } finally {
    closeStorageDatabase(database);
  }
}

/** 全域 inspect 成功后打开唯一可写连接，并发布 outbox 镜像。 */
export function adoptStorageDatabase(
  inspection: StorageDatabaseInspection
): StorageDatabaseHydration {
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
    requireWritableAccess: true,
  });
  storageDatabaseHandle.current = database;
  for (const [removalId, pending] of inspection.hydration.pendingBlockedRemovals) {
    removalSnapshot.set(removalId, pending);
  }
  for (const [removalId, data] of inspection.pendingRemovalData) {
    removalSnapshotData.set(removalId, data);
  }
  return {
    ...inspection.hydration,
    // LoadedReply 直接交出 owner 快照；同一 Worker 消息轮内不会并发修改。
    pendingBlockedRemovals: removalSnapshot,
  };
}

/** 单领域恢复入口；跨域启动编排使用 inspect/adopt 两阶段 API。 */
export function hydrateStorageDatabase(): StorageDatabaseHydration {
  return adoptStorageDatabase(inspectStorageDatabase());
}
