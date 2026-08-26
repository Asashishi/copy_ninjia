import { chatQa } from "../schema/chatQa";
import { chatStates } from "../schema/chatState";
import { blocklistEntries, whitelistEntries } from "../schema/identityPolicy";
import { storageMetadata } from "../schema/metadata";
import { pendingBlockedRemovals } from "../schema/pendingRemoval";
import type {
  StorageDatabase,
  StoredChatQaRow,
  StoredChatStateRow,
  StoredIdentityPolicyRow,
  StoredPendingRemovalRow,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";

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
}

/** 测试与性能夹具在一个 Drizzle 事务内写入 schema 元数据和全部业务行。 */
export function seedStorageDatabase(
  database: StorageDatabase,
  {
    metadata,
    whitelist,
    blocklist,
    removals,
    chatStates: storedChatStates = [],
    chatQa: storedChatQa = [],
  }: SeedStorageDatabaseOptions
): void {
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    if (metadata.length > 0) transaction.insert(storageMetadata).values([...metadata]).run();
    if (whitelist.length > 0) transaction.insert(whitelistEntries).values([...whitelist]).run();
    if (blocklist.length > 0) transaction.insert(blocklistEntries).values([...blocklist]).run();
    if (removals.length > 0) transaction.insert(pendingBlockedRemovals).values([...removals]).run();
    if (storedChatStates.length > 0) transaction.insert(chatStates).values([...storedChatStates]).run();
    if (storedChatQa.length > 0) transaction.insert(chatQa).values([...storedChatQa]).run();
  });
}

/** 清空全部业务表；测试隔离复用同一空 schema 时使用。 */
export function clearStorageBusinessTables(database: StorageDatabase): void {
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    transaction.delete(chatQa).run();
    transaction.delete(pendingBlockedRemovals).run();
    transaction.delete(whitelistEntries).run();
    transaction.delete(blocklistEntries).run();
    transaction.delete(chatStates).run();
  });
}
