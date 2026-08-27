import {
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
} from "../../consts/identityStorage";
import { storageMetadata } from "../schema/metadata";
import type {
  StorageDatabase,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";

type StorageDatabaseTransaction = Parameters<
  Parameters<StorageDatabase["transaction"]>[0]
>[0];

/** 为迁移刚创建的空库写入唯一的当前 schema 版本行。 */
export function initializeStorageDatabase(database: StorageDatabase): void {
  const metadata: StoredStorageMetadataRow = {
    key: IDENTITY_DATABASE_SCHEMA_KEY,
    data: IDENTITY_DATABASE_SCHEMA_DATA,
  };
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    transaction.insert(storageMetadata).values(metadata).run();
  });
}
