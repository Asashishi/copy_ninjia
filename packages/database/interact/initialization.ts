import {
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_DATABASE_TIME_ZONE_KEY,
} from "../../consts/identityStorage";
import { storageMetadata } from "../schema/metadata";
import type {
  StorageDatabase,
  StorageTimeZoneMetadata,
  StoredStorageMetadataRow,
} from "../../types/storageDatabase";

type StorageDatabaseTransaction = Parameters<
  Parameters<StorageDatabase["transaction"]>[0]
>[0];

/**
 * 当前格式 storage_metadata 的全部行：schema 版本与数据根绑定的时区标记。
 *
 * timeZone 必须是 config/timeZoneInput.ts 规范化后的配置时区；建库与测试夹具共用这一份
 * 行构造，启动按同一形态严格比对。
 */
export function storageMetadataRows(
  timeZone: string
): readonly StoredStorageMetadataRow[] {
  const marker: StorageTimeZoneMetadata = { timeZone };
  return [
    { key: IDENTITY_DATABASE_SCHEMA_KEY, data: IDENTITY_DATABASE_SCHEMA_DATA },
    { key: IDENTITY_DATABASE_TIME_ZONE_KEY, data: JSON.stringify(marker) },
  ];
}

/** 为迁移刚创建的空库在一个事务内写入当前 schema 版本与配置时区标记。 */
export function initializeStorageDatabase(
  database: StorageDatabase,
  timeZone: string
): void {
  const rows: readonly StoredStorageMetadataRow[] = storageMetadataRows(timeZone);
  database.transaction((transaction: StorageDatabaseTransaction): void => {
    transaction.insert(storageMetadata).values([...rows]).run();
  });
}
