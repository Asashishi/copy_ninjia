import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { IDENTITY_DATABASE_MIGRATIONS_DIR } from "../../consts/identityStorage";
import { storageDatabaseSchema } from "../schema/storage";
import type {
  StorageDatabase,
  StorageDatabaseMigrationJournalEntry,
} from "../../types/storageDatabase";

/** 创建新库并交给 Drizzle 内建 migrator 建表；已存在时拒绝覆盖。 */
export function createStorageDatabase(path: string): void {
  if (existsSync(path)) {
    throw new Error(`${path}: target already exists; refusing to overwrite it.`);
  }
  const client: Database = new Database(path, {
    create: true,
    readwrite: true,
    strict: true,
    safeIntegers: false,
  });
  try {
    const database: StorageDatabase = drizzle({ client, schema: storageDatabaseSchema });
    migrateStorageDatabaseSchema(database);
  } finally {
    client.close(false);
  }
}

/**
 * 对已由部署流程完成外部备份的共享存储库显式执行 schema migrations。
 * 生产启动路径不得调用；旧版本必须先停服务并手工迁移，再进入严格 hydrate。
 */
export function migrateStorageDatabaseSchema(database: StorageDatabase): void {
  migrate(database, { migrationsFolder: IDENTITY_DATABASE_MIGRATIONS_DIR });
}

/** 读取并严格校验 Drizzle 迁移谱系；部署脚本据此拒绝未知历史。 */
export function readStorageDatabaseMigrationJournal(
  database: StorageDatabase
): readonly StorageDatabaseMigrationJournalEntry[] {
  const rows: StorageDatabaseMigrationJournalEntry[] = database.$client
    .query<StorageDatabaseMigrationJournalEntry, []>(
      "SELECT created_at AS createdAt, hash " +
      "FROM __drizzle_migrations ORDER BY created_at ASC;"
    )
    .all();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.createdAt) ||
      row.createdAt < 1 ||
      !/^[a-f0-9]{64}$/.test(row.hash)
    ) {
      throw new Error("Storage database contains an invalid Drizzle migration journal entry.");
    }
  }
  return rows;
}
