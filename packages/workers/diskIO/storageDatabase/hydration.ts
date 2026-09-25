import {
  removalSnapshot,
  removalSnapshotData,
  resetStorageDatabaseCache,
  storageDatabaseHandle,
} from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { closeStorageDatabase, openStorageDatabase } from "../../../database/interact/connection";
import { validateStorageDatabase } from "../../../database/interact/validation";
import type { StorageDatabase } from "../../../types/storageDatabase";
import type { StorageDatabaseHydration, StorageDatabaseInspection } from "../../../types/identityStorage";

/** 跨域启动第一阶段：以只读连接严格校验并重建有限快照。 */
export function inspectStorageDatabase(): StorageDatabaseInspection {
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
    readonly: true,
    requireWritableAccess: true,
  });
  try {
    return validateStorageDatabase(database, IDENTITY_DATABASE_PATH);
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
