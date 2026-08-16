import { chatStates } from "../schema/chatState";
import { blocklistEntries, whitelistEntries } from "../schema/identityPolicy";
import { storageMetadata } from "../schema/metadata";
import { pendingBlockedRemovals } from "../schema/pendingRemoval";
import type { IdentityPolicyTable } from "../../types/identityPolicy";
import type {
  StorageDatabase,
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
}

/** 一次性迁移在一个 Drizzle 事务内写入 JSONB schema 版本和全部业务行。 */
export function seedStorageDatabase(
  database: StorageDatabase,
  {
    metadata,
    whitelist,
    blocklist,
    removals,
    chatStates: storedChatStates = [],
  }: SeedStorageDatabaseOptions
): void {
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    if (metadata.length > 0) transaction.insert(storageMetadata).values([...metadata]).run();
    if (whitelist.length > 0) transaction.insert(whitelistEntries).values([...whitelist]).run();
    if (blocklist.length > 0) transaction.insert(blocklistEntries).values([...blocklist]).run();
    if (removals.length > 0) transaction.insert(pendingBlockedRemovals).values([...removals]).run();
    if (storedChatStates.length > 0) transaction.insert(chatStates).values([...storedChatStates]).run();
  });
}

/** 清空全部业务表；测试隔离复用同一空 schema 时使用。 */
export function clearStorageBusinessTables(database: StorageDatabase): void {
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    transaction.delete(pendingBlockedRemovals).run();
    transaction.delete(whitelistEntries).run();
    transaction.delete(blocklistEntries).run();
    transaction.delete(chatStates).run();
  });
}

export interface PutIdentityPolicyRowOptions {
  readonly database: StorageDatabase;
  readonly table: IdentityPolicyTable;
  readonly id: number;
  readonly data: string;
}

/** 写入一条原始名单行；迁移逐值校验和损坏数据回归测试使用。 */
export function putIdentityPolicyRow({
  database,
  table,
  id,
  data,
}: PutIdentityPolicyRowOptions): void {
  if (table === "whitelist") {
    database.insert(whitelistEntries).values({ id, data })
      .onConflictDoUpdate({ target: whitelistEntries.id, set: { data } }).run();
    return;
  }
  database.insert(blocklistEntries).values({ id, data })
    .onConflictDoUpdate({ target: blocklistEntries.id, set: { data } }).run();
}
