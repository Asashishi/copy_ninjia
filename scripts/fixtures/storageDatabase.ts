import {
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
} from "../../packages/consts/identityStorage";
import { chatQa } from "../../packages/database/schema/chatQa";
import { chatStates } from "../../packages/database/schema/chatState";
import {
  blocklistEntries,
  permissionList,
} from "../../packages/database/schema/identityPolicy";
import { storageMetadata } from "../../packages/database/schema/metadata";
import { pendingBlockedRemovals } from
  "../../packages/database/schema/pendingRemoval";
import { temporaryAdBypassEntries } from
  "../../packages/database/schema/temporaryAdBypass";
import type { StoredTemporaryAdBypassActivity } from
  "../../packages/types/temporaryAdBypass";
import type {
  StorageDatabase,
  StoredChatQaRow,
  StoredChatStateRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
  StoredStorageMetadataRow,
} from "../../packages/types/storageDatabase";

type StorageDatabaseTransaction = Parameters<
  Parameters<StorageDatabase["transaction"]>[0]
>[0];

/**
 * 当前 schema 版本行，夹具与基准建库时的唯一来源。
 *
 * 生产建库由 install.sh 调 packages/database/interact/initialization.ts 的
 * initializeStorageDatabase 写这一笔；夹具走 seedStorageDatabase，要和业务行
 * 在同一个事务里落。两条路写的必须是同一行，因此这里只留一份字面量，
 * 版本变更时不会漏改某个夹具。缺这一行时启动恢复会拒绝加载整个库。
 */
export const CURRENT_STORAGE_METADATA_ROWS: readonly Readonly<StoredStorageMetadataRow>[] = [{
  key: IDENTITY_DATABASE_SCHEMA_KEY,
  data: IDENTITY_DATABASE_SCHEMA_DATA,
}];

export interface SeedStorageDatabaseOptions {
  readonly metadata: readonly StoredStorageMetadataRow[];
  readonly whitelist: readonly StoredIdentityPolicyRow[];
  readonly blocklist: readonly StoredIdentityPolicyRow[];
  readonly removals: readonly StoredPendingRemovalRow[];
  readonly chatStates?: readonly StoredChatStateRow[];
  readonly chatQa?: readonly StoredChatQaRow[];
  readonly temporaryAdBypass?: readonly StoredTemporaryAdBypassActivity[];
}

/** 测试与性能夹具在一个 Drizzle 事务内写入全部初始行。 */
export function seedStorageDatabase(
  database: StorageDatabase,
  {
    metadata,
    whitelist,
    blocklist,
    removals,
    chatStates: storedChatStates = [],
    chatQa: storedChatQa = [],
    temporaryAdBypass = [],
  }: SeedStorageDatabaseOptions
): void {
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    if (metadata.length > 0) {
      transaction.insert(storageMetadata).values([...metadata]).run();
    }
    if (whitelist.length > 0) {
      transaction.insert(permissionList).values([...whitelist]).run();
    }
    if (blocklist.length > 0) {
      transaction.insert(blocklistEntries).values([...blocklist]).run();
    }
    if (removals.length > 0) {
      transaction.insert(pendingBlockedRemovals).values([...removals]).run();
    }
    if (storedChatStates.length > 0) {
      transaction.insert(chatStates).values(storedChatStates.map((row: StoredChatStateRow): typeof chatStates.$inferInsert => ({ chatId: row.chatId, status: row.data, aiPersona: row.aiPersona }))).run();
    }
    if (storedChatQa.length > 0) {
      transaction.insert(chatQa).values([...storedChatQa]).run();
    }
    if (temporaryAdBypass.length > 0) {
      transaction.insert(temporaryAdBypassEntries).values([...temporaryAdBypass]).run();
    }
  });
}

/** 清空夹具数据库的全部业务表。 */
export function clearStorageBusinessTables(database: StorageDatabase): void {
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    transaction.delete(chatQa).run();
    transaction.delete(pendingBlockedRemovals).run();
    transaction.delete(permissionList).run();
    transaction.delete(blocklistEntries).run();
    transaction.delete(chatStates).run();
    transaction.delete(temporaryAdBypassEntries).run();
  });
}
