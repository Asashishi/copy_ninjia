import { storageDatabaseHandle } from "../../../cache/workers/diskIO/storageDatabase";
import { IDENTITY_DATABASE_PATH } from "../../../consts/paths";
import { storageRowSource } from "../../../database/validation/storageRows";
import type { StorageDatabase } from "../../../types/storageDatabase";

/** 返回 Disk I/O Worker 独占连接；hydrate 前调用一律视为生命周期错误。 */
export function requireStorageDatabase(): StorageDatabase {
  const database: StorageDatabase | null = storageDatabaseHandle.current;
  if (database === null) {
    throw new Error(`${IDENTITY_DATABASE_PATH}: database must be loaded before use.`);
  }
  return database;
}

/** 统一生成当前部署数据库业务行的安全来源路径。 */
export function storageSource(table: string, id: number | string): string {
  return storageRowSource(IDENTITY_DATABASE_PATH, table, id);
}
