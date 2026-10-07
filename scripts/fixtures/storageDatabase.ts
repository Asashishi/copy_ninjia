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

export interface SeedStorageDatabaseOptions {
  readonly metadata: readonly StoredStorageMetadataRow[];
  readonly whitelist: readonly StoredIdentityPolicyRow[];
  readonly blocklist: readonly StoredIdentityPolicyRow[];
  readonly removals: readonly StoredPendingRemovalRow[];
  readonly chatStates?: readonly StoredChatStateRow[];
  readonly chatQa?: readonly StoredChatQaRow[];
  readonly temporaryAdBypass?: readonly StoredTemporaryAdBypassActivity[];
}

/**
 * 测试与性能夹具在一个 Drizzle 事务内写入全部初始行。当前格式的 metadata 用
 * packages/database/interact/initialization.ts 的 storageMetadataRows 构造（与安装器建库同源），
 * 其时区必须等于读这份库的进程所接管的配置时区。
 */
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
      transaction.insert(chatStates).values(storedChatStates.map((row: StoredChatStateRow): typeof chatStates.$inferInsert => ({ chatId: row.chatId, status: row.data }))).run();
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
