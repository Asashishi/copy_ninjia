/**
 * 干净停机时关闭共享 SQLite：提交残余写、`PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 合回主库并截断，
 * 再关闭连接。由 diskIOWorker.ts 的 closeStorage 请求触发，之后本 isolate 不再访问数据库。
 */

import {
  storageDatabaseClosed,
  storageDatabaseHandle,
  storageWriteFlushTimer,
} from "../../../cache/workers/diskIO/storageDatabase";
import { closeStorageDatabase } from "../../../database/interact/connection";
import type { IdentityPersistenceReply, StorageCloseOutcome } from "../../../types/diskIO/replies";
import type { StorageDatabase } from "../../../types/storageDatabase";
import { flushStorageDatabase } from "./flush";
import { requireStorageDatabase } from "./context";

/** `PRAGMA wal_checkpoint` 的结果行：busy 非 0 表示有读连接挡住，WAL 未能完整截断。 */
interface WalCheckpointRow {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

/**
 * 先以一个事务提交残余写（失败时照样继续关库，结局里记 committed=false），再执行 TRUNCATE
 * checkpoint 并关闭连接，句柄置空、置位 storageDatabaseClosed，清掉定时提交。checkpoint 或
 * 关库抛错时同样置位关闭标记后把错误抛给调用方。
 */
export function closeStorageDatabaseForShutdown(reply: IdentityPersistenceReply): StorageCloseOutcome {
  const database: StorageDatabase = requireStorageDatabase();
  const committed: boolean = flushStorageDatabase(reply);
  storageDatabaseClosed.current = true;
  if (storageWriteFlushTimer.current !== null) {
    clearTimeout(storageWriteFlushTimer.current);
    storageWriteFlushTimer.current = null;
  }
  storageDatabaseHandle.current = null;
  try {
    const row: WalCheckpointRow | null = database.$client
      .query<WalCheckpointRow, []>("PRAGMA wal_checkpoint(TRUNCATE);")
      .get();
    return { committed, checkpointBusy: row?.busy !== 0 };
  } finally {
    closeStorageDatabase(database);
  }
}
