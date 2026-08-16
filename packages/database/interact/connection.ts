import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { storageDatabaseSchema } from "../schema/storage";
import type { StorageDatabase } from "../../types/storageDatabase";

export interface OpenStorageDatabaseOptions {
  readonly path: string;
  readonly readonly?: boolean;
  readonly requireWritableAccess?: boolean;
}

/** 打开既有共享存储数据库；生产 owner 可同时要求文件和父目录具备写权限。 */
export function openStorageDatabase({
  path,
  readonly: isReadonly = false,
  requireWritableAccess = false,
}: OpenStorageDatabaseOptions): StorageDatabase {
  if (!existsSync(path)) {
    throw new Error(`${path}: database file is missing; run the storage migration first.`);
  }
  if (requireWritableAccess) {
    accessSync(path, constants.R_OK | constants.W_OK);
    accessSync(dirname(path), constants.R_OK | constants.W_OK | constants.X_OK);
  }
  const client: Database = new Database(path, {
    create: false,
    ...(isReadonly ? { readonly: true } : { readwrite: true }),
    strict: true,
    safeIntegers: false,
  });
  return drizzle({ client, schema: storageDatabaseSchema });
}

/** 关闭共享存储数据库连接；由持有句柄的调用边界显式触发。 */
export function closeStorageDatabase(database: StorageDatabase): void {
  database.$client.close(false);
}

/** 生成包含当前 WAL 可见状态的一致 SQLite 字节快照，供工作树外迁移备份使用。 */
export function serializeStorageDatabaseSnapshot(
  database: StorageDatabase
): Uint8Array {
  return database.$client.serialize();
}

/** 按 Bun 官方建议为已发布的新库启用 WAL。 */
export function enableStorageDatabaseWal(path: string): void {
  const database: StorageDatabase = openStorageDatabase({ path });
  try {
    database.$client.run("PRAGMA journal_mode = WAL;");
  } finally {
    closeStorageDatabase(database);
  }
}
