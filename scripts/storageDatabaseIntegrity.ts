import type { StorageDatabase } from "../packages/types/storageDatabase";

/** SQLite 原生完整性检查的一行诊断结果。 */
interface StorageDatabaseIntegrityRow {
  readonly integrity_check: string;
}

/** 仅供冷迁移编排在开始和成功结束前各执行一次；生产代码不得导入。 */
export function assertStorageDatabaseIntegrity(database: StorageDatabase): void {
  const rows: StorageDatabaseIntegrityRow[] = database.$client
    .query<StorageDatabaseIntegrityRow, []>("PRAGMA integrity_check;")
    .all();
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error("Storage database failed SQLite integrity_check.");
  }
}
