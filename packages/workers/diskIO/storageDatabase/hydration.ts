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
import { openStorageDatabase } from "../../../database/interact/connection";
import {
  assertStorageDatabaseStartupJsonbStorage,
  readStorageDatabasePendingRemovalPage,
  readStorageDatabaseSchemaMetadata,
  readStorageDatabaseStartupRows,
} from "../../../database/interact/inspection";
import {
  decodeStoredPendingRemovals,
  readStorageSchemaVersion,
  restoreStoredChatStates,
} from "../../../database/validation/storageRows";
import type { ChatState } from "../../../types/chatState";
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
function hydratePendingRemovalPages(database: StorageDatabase): void {
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
      removalSnapshot.set(removalId, pending);
    }
    for (const [removalId, data] of removals.encoded) {
      removalSnapshotData.set(removalId, data);
    }
    if (page.length < BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE) return;
    const last: StoredPendingRemovalStartupRow | undefined = page.at(-1);
    if (last === undefined) return;
    afterRemovalId = last.removalId;
  }
}

/** 打开并恢复有限状态；名单只取计数，群状态只解析当前格式而不做启动正确性校验。 */
export function hydrateStorageDatabase(): StorageDatabaseHydration {
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
    requireWritableAccess: true,
  });
  storageDatabaseHandle.current = database;
  try {
    assertStorageDatabaseStartupJsonbStorage(database, IDENTITY_DATABASE_PATH);
    // 版本判定必须排在读取业务行**之前**：`chat_states` 是 v4 才建的表，先读
    // startup rows 的话，一个没迁移的 v3 库会以 `no such table: chat_states`
    // 失败——拒绝启动是对的，但运维拿到的是一句 SQLite 原始报错，而不是下面这条
    // 点名 schema 版本、指向 `bun run migrate:chat-state` 的结论。
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
    const rows: StorageDatabaseStartupRows = readStorageDatabaseStartupRows(database);
    hydratePendingRemovalPages(database);
    const chatStates: Map<number, ChatState> = restoreStoredChatStates(
      rows.chatStates,
      IDENTITY_DATABASE_PATH
    );
    return {
      blocklistEntryCount: rows.blocklistEntryCount,
      whitelistEntryCount: rows.whitelistEntryCount,
      pendingBlockedRemovals: new Map(removalSnapshot),
      chatStates,
    };
  } catch (error: unknown) {
    resetStorageDatabaseCache();
    throw error;
  }
}
