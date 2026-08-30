import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
  IDENTITY_WRITE_FLUSH_INTERVAL_MS,
} from "../../../packages/consts/identityStorage";
import { DAY_MS } from "../../../packages/consts/diskIO/common";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import {
  pendingTemporaryWhitelistWrites,
  resetStorageDatabaseCache,
  storagePersistenceReplyHolder,
  storageDatabaseHandle,
  storageWriteFlushTimer,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { readStoredTemporaryWhitelistActivities } from
  "../../../packages/database/interact/temporaryWhitelist";
import { clearStorageBusinessTables } from
  "../../../scripts/fixtures/storageDatabase";
import {
  configureStoragePersistenceReply,
  flushStorageDatabase,
} from "../../../packages/workers/diskIO/storageDatabase/flush";
import { hydrateStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/hydration";
import {
  handleTemporaryWhitelistWrite,
  sweepExpiredTemporaryWhitelistActivities,
} from "../../../packages/workers/diskIO/storageDatabase/temporaryWhitelist";
import type {
  IdentityStoragePersistedReply,
  TemporaryWhitelistWriteDiskMessage,
} from "../../../packages/types/diskIO";
import type { StorageDatabase } from
  "../../../packages/types/storageDatabase";
import type { StoredTemporaryWhitelistActivity } from
  "../../../packages/types/temporaryWhitelist";

const NOW: number = new Date("2026-08-29T12:00:00+09:00").getTime();
const acknowledgements: IdentityStoragePersistedReply[] = [];

function reply(value: IdentityStoragePersistedReply): void {
  acknowledgements.push(value);
}

interface ActivityWriteOptions {
  readonly countedAt?: number;
  readonly sendCount?: number;
  readonly tempWhite?: boolean;
  readonly tempWhiteCount?: number;
}

function activityWrite(
  id: number,
  revision: number,
  {
    countedAt = NOW,
    sendCount = 1,
    tempWhite = false,
    tempWhiteCount = tempWhite ? 1 : 0,
  }: ActivityWriteOptions = {}
): TemporaryWhitelistWriteDiskMessage {
  const storedSendCount: number = tempWhite ? Math.max(sendCount, 8) : sendCount;
  return {
    type: "temporaryWhitelistWrite",
    id,
    revision,
    activity: {
      tempWhite,
      tempWhiteAt: tempWhite ? countedAt : null,
      tempWhiteCount,
      sendCount: storedSendCount,
      countedAt,
      qualifiedAt: tempWhite ? countedAt : null,
    },
  };
}

function resetDatabaseFixture(): void {
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  clearStorageBusinessTables(database);
  closeStorageDatabase(database);
  hydrateStorageDatabase();
}

beforeEach((): void => {
  acknowledgements.length = 0;
  storagePersistenceReplyHolder.current = null;
  resetDatabaseFixture();
});

afterEach((): void => {
  resetStorageDatabaseCache();
  storagePersistenceReplyHolder.current = null;
  jest.useRealTimers();
});

describe("临时白名单 SQLite 合并写与过期清理", () => {
  test("同一主键在 30 秒窗口内只落最新最终值与 revision", (): void => {
    jest.useFakeTimers({ now: NOW });
    configureStoragePersistenceReply(reply);

    handleTemporaryWhitelistWrite(activityWrite(7, 1), reply);
    const firstTimer: ReturnType<typeof setTimeout> | null = storageWriteFlushTimer.current;
    handleTemporaryWhitelistWrite(activityWrite(7, 2, { sendCount: 2 }), reply);

    expect(pendingTemporaryWhitelistWrites).toHaveLength(1);
    expect(pendingTemporaryWhitelistWrites.get(7)?.revision).toBe(2);
    expect(storageWriteFlushTimer.current).toBe(firstTimer);
    expect(firstTimer?.hasRef()).toBeFalse();

    jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);

    expect(pendingTemporaryWhitelistWrites).toHaveLength(0);
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [],
      temporaryWhitelistWrites: [{ id: 7, revision: 2 }],
      chatStateWrites: [],
      chatQaWrites: [],
    }]);
    expect(readStoredTemporaryWhitelistActivities(
      requireStorageDatabaseFixture(),
      [7]
    )[0]?.sendCount).toBe(2);
  });

  test("第 128 个不同主键到达时立即以一个事务提交整批", (): void => {
    for (let id: number = 1; id <= IDENTITY_WRITE_BATCH_MAX_ENTRIES; id++) {
      handleTemporaryWhitelistWrite(activityWrite(id, 1), reply);
      if (id < IDENTITY_WRITE_BATCH_MAX_ENTRIES) {
        expect(acknowledgements).toHaveLength(0);
      }
    }

    expect(pendingTemporaryWhitelistWrites).toHaveLength(0);
    expect(storageWriteFlushTimer.current).toBeNull();
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]?.temporaryWhitelistWrites)
      .toHaveLength(IDENTITY_WRITE_BATCH_MAX_ENTRIES);
    const database: StorageDatabase = requireStorageDatabaseFixture();
    const count: { readonly value: number } | null = database.$client
      .query<{ readonly value: number }, []>(
        "SELECT COUNT(*) AS value FROM temporary_whitelist_entries;"
      ).get();
    expect(count?.value).toBe(IDENTITY_WRITE_BATCH_MAX_ENTRIES);
  });

  test("零点清理只删除超过 24 小时未发言的未授权累计", (): void => {
    handleTemporaryWhitelistWrite(activityWrite(7, 1, {
      countedAt: NOW - DAY_MS - 1,
    }), reply);
    handleTemporaryWhitelistWrite(activityWrite(8, 1, {
      countedAt: NOW - DAY_MS,
    }), reply);
    handleTemporaryWhitelistWrite(activityWrite(9, 1), reply);
    handleTemporaryWhitelistWrite(activityWrite(10, 1, {
      countedAt: NOW - DAY_MS - 1,
      tempWhite: true,
    }), reply);
    expect(flushStorageDatabase(reply)).toBeTrue();

    sweepExpiredTemporaryWhitelistActivities(NOW);

    const rows: readonly StoredTemporaryWhitelistActivity[] =
      readStoredTemporaryWhitelistActivities(
        requireStorageDatabaseFixture(),
        [7, 8, 9, 10]
      );
    expect(rows.map((row: StoredTemporaryWhitelistActivity): number => row.id))
      .toEqual([8, 9, 10]);
  });

});

function requireStorageDatabaseFixture(): StorageDatabase {
  const database: StorageDatabase | null = storageDatabaseHandle.current;
  if (database === null) throw new Error("storage database fixture must be hydrated");
  return database;
}
