/** Disk I/O Worker 干净停机关库：残余写提交、TRUNCATE checkpoint、关库与关库后的写入忽略。 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../../packages/consts/whitelist";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import { encodeWhitelistEntryData } from "../../../packages/database/codec/identity";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import {
  pendingWhitelistWrites,
  resetStorageDatabaseCache,
  storageDatabaseClosed,
  storageDatabaseHandle,
  storageWriteFlushTimer,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import { flushStorageDatabase } from "../../../packages/workers/diskIO/storageDatabase/flush";
import { handleIdentityPolicyWrite } from "../../../packages/workers/diskIO/storageDatabase/identityPolicy";
import { closeStorageDatabaseForShutdown } from "../../../packages/workers/diskIO/storageDatabase/shutdown";
import { clearStorageBusinessTables } from "../../../scripts/fixtures/storageDatabase";
import { hydrateStorageDatabase } from "../../helpers/storageDatabaseHydration";
import type {
  IdentityPolicyWriteDiskMessage,
  IdentityStoragePersistedReply,
} from "../../../packages/types/diskIO";
import type { StorageDatabase } from "../../../packages/types/storageDatabase";

const acknowledgements: IdentityStoragePersistedReply[] = [];

function reply(value: IdentityStoragePersistedReply): void {
  acknowledgements.push(value);
}

function whitelistWrite(id: number, revision: number): IdentityPolicyWriteDiskMessage {
  return {
    type: "identityPolicyWrite",
    table: "whitelist",
    id,
    data: encodeWhitelistEntryData({
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "成员", lastName: "", username: "" },
    }),
    revision,
  };
}

function whitelistRowCount(): number {
  const database: Database = new Database(IDENTITY_DATABASE_PATH, { readonly: true });
  try {
    return database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM permission_list;").get()!.count;
  } finally {
    database.close();
  }
}

beforeEach((): void => {
  acknowledgements.length = 0;
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  clearStorageBusinessTables(database);
  closeStorageDatabase(database);
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
  hydrateStorageDatabase();
});

afterEach((): void => {
  resetStorageDatabaseCache();
});

describe("干净停机关库", (): void => {
  test("先提交残余写再 checkpoint 关库：WAL/SHM 删除，主库重开后行数一致", (): void => {
    handleIdentityPolicyWrite(whitelistWrite(7, 1), reply);
    expect(pendingWhitelistWrites.size).toBe(1);
    expect(existsSync(`${IDENTITY_DATABASE_PATH}-wal`)).toBeTrue();

    expect(closeStorageDatabaseForShutdown(reply)).toEqual({ committed: true, checkpointBusy: false });

    expect(acknowledgements.map((ack: IdentityStoragePersistedReply): unknown => ack.writes))
      .toEqual([[{ table: "whitelist", id: 7, revision: 1 }]]);
    expect(storageDatabaseHandle.current).toBeNull();
    expect(storageDatabaseClosed.current).toBeTrue();
    expect(storageWriteFlushTimer.current).toBeNull();
    expect(existsSync(`${IDENTITY_DATABASE_PATH}-wal`)).toBeFalse();
    expect(existsSync(`${IDENTITY_DATABASE_PATH}-shm`)).toBeFalse();
    expect(whitelistRowCount()).toBe(1);
  });

  test("另一条读连接持有读事务时 checkpoint 报 busy，关库照常完成，WAL 留在原地", (): void => {
    const reader: Database = new Database(IDENTITY_DATABASE_PATH, { readonly: true });
    try {
      reader.run("BEGIN;");
      reader.query("SELECT COUNT(*) FROM permission_list;").get();
      handleIdentityPolicyWrite(whitelistWrite(8, 1), reply);

      expect(closeStorageDatabaseForShutdown(reply)).toEqual({ committed: true, checkpointBusy: true });

      expect(storageDatabaseHandle.current).toBeNull();
      expect(existsSync(`${IDENTITY_DATABASE_PATH}-wal`)).toBeTrue();
      reader.run("COMMIT;");
    } finally {
      reader.close();
    }
    expect(whitelistRowCount()).toBe(1);
  });

  test("关库后不再提交，也不再挂定时提交", (): void => {
    closeStorageDatabaseForShutdown(reply);
    pendingWhitelistWrites.set(9, { data: whitelistWrite(9, 1).data, revision: 1 });

    expect(flushStorageDatabase(reply)).toBeFalse();
    expect(storageWriteFlushTimer.current).toBeNull();
    expect(acknowledgements).toEqual([]);
  });

  test("未加载时关库按生命周期错误抛出", (): void => {
    resetStorageDatabaseCache();
    expect((): unknown => closeStorageDatabaseForShutdown(reply)).toThrow("database must be loaded before use");
    expect(storageDatabaseClosed.current).toBeFalse();
  });
});
