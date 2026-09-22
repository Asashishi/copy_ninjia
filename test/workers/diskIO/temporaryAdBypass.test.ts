import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
  IDENTITY_WRITE_FLUSH_INTERVAL_MS,
} from "../../../packages/consts/identityStorage";
import { DAY_MS } from "../../../packages/consts/diskIO/common";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import {
  pendingTemporaryAdBypassWrites,
  resetStorageDatabaseCache,
  storagePersistenceReplyHolder,
  storageDatabaseHandle,
  storageWriteFlushTimer,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import { readStoredTemporaryAdBypassActivities } from
  "../../../packages/database/interact/temporaryAdBypass";
import { clearStorageBusinessTables } from
  "../../../scripts/fixtures/storageDatabase";
import {
  configureStoragePersistenceReply,
  flushStorageDatabase,
} from "../../../packages/workers/diskIO/storageDatabase/flush";
import { hydrateStorageDatabase } from "../../helpers/storageDatabaseHydration";
import {
  handleTemporaryAdBypassWrite,
  maintainTemporaryAdBypassActivities,
} from "../../../packages/workers/diskIO/storageDatabase/temporaryAdBypass";
import type {
  IdentityStoragePersistedReply,
  TemporaryAdBypassWriteDiskMessage,
} from "../../../packages/types/diskIO";
import type { StorageDatabase } from
  "../../../packages/types/storageDatabase";
import type { StoredTemporaryAdBypassActivity } from
  "../../../packages/types/temporaryAdBypass";

const NOW: number = new Date("2026-08-30T00:00:00+09:00").getTime();
const acknowledgements: IdentityStoragePersistedReply[] = [];

function reply(value: IdentityStoragePersistedReply): void {
  acknowledgements.push(value);
}

interface ActivityWriteOptions {
  readonly countedAt?: number;
  readonly qualified?: boolean;
  readonly sendCount?: number;
  readonly adBypass?: boolean;
  readonly qualifiedDays?: number;
}

function activityWrite(
  id: number,
  revision: number,
  {
    countedAt = NOW,
    sendCount = 1,
    adBypass = false,
    qualified = adBypass,
    qualifiedDays = adBypass ? 1 : 0,
  }: ActivityWriteOptions = {}
): TemporaryAdBypassWriteDiskMessage {
  const storedSendCount: number = qualified ? Math.max(sendCount, 8) : sendCount;
  return {
    type: "temporaryAdBypassWrite",
    id,
    revision,
    activity: {
      adBypass,
      adBypassGrantedAt: adBypass ? countedAt : null,
      qualifiedDays,
      sendCount: storedSendCount,
      countedAt,
      qualifiedAt: qualified ? countedAt : null,
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
  jest.useFakeTimers({ now: NOW });
  resetDatabaseFixture();
});

afterEach((): void => {
  resetStorageDatabaseCache();
  storagePersistenceReplyHolder.current = null;
  jest.useRealTimers();
});

describe("临时广告免检 SQLite 合并写与过期清理", () => {
  test("同一主键在 30 秒窗口内只落最新最终值与 revision", (): void => {
    configureStoragePersistenceReply(reply);

    handleTemporaryAdBypassWrite(activityWrite(7, 1), reply);
    const firstTimer: ReturnType<typeof setTimeout> | null = storageWriteFlushTimer.current;
    handleTemporaryAdBypassWrite(activityWrite(7, 2, { sendCount: 2 }), reply);

    expect(pendingTemporaryAdBypassWrites).toHaveLength(1);
    expect(pendingTemporaryAdBypassWrites.get(7)?.revision).toBe(2);
    expect(storageWriteFlushTimer.current).toBe(firstTimer);
    expect(firstTimer?.hasRef()).toBeFalse();

    jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);

    expect(pendingTemporaryAdBypassWrites).toHaveLength(0);
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [],
      temporaryAdBypassWrites: [{ id: 7, revision: 2 }],
      chatStateWrites: [],
      chatQaWrites: [],
    }]);
    expect(readStoredTemporaryAdBypassActivities(
      requireStorageDatabaseFixture(),
      [7]
    )[0]?.sendCount).toBe(2);
  });

  test("第 128 个不同主键到达时立即以一个事务提交整批", (): void => {
    for (let id: number = 1; id <= IDENTITY_WRITE_BATCH_MAX_ENTRIES; id++) {
      handleTemporaryAdBypassWrite(activityWrite(id, 1), reply);
      if (id < IDENTITY_WRITE_BATCH_MAX_ENTRIES) {
        expect(acknowledgements).toHaveLength(0);
      }
    }

    expect(pendingTemporaryAdBypassWrites).toHaveLength(0);
    expect(storageWriteFlushTimer.current).toBeNull();
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]?.temporaryAdBypassWrites)
      .toHaveLength(IDENTITY_WRITE_BATCH_MAX_ENTRIES);
    const database: StorageDatabase = requireStorageDatabaseFixture();
    const count: { readonly value: number } | null = database.$client
      .query<{ readonly value: number }, []>(
        "SELECT COUNT(*) AS value FROM temporary_ad_bypass_entries;"
      ).get();
    expect(count?.value).toBe(IDENTITY_WRITE_BATCH_MAX_ENTRIES);
  });

  test("零点先提交在途写，再删除未在刚结束东京日达标的旧累计", (): void => {
    jest.setSystemTime(NOW - 1);
    handleTemporaryAdBypassWrite(activityWrite(7, 1, {
      countedAt: NOW - 1,
    }), reply);
    handleTemporaryAdBypassWrite(activityWrite(8, 1, {
      countedAt: NOW,
    }), reply);
    handleTemporaryAdBypassWrite(activityWrite(9, 1, {
      countedAt: NOW - 1,
      adBypass: true,
    }), reply);
    handleTemporaryAdBypassWrite(activityWrite(10, 1, {
      countedAt: NOW - DAY_MS - 1,
      adBypass: true,
    }), reply);
    handleTemporaryAdBypassWrite(activityWrite(11, 1, {
      countedAt: NOW - 1,
      qualified: false,
      sendCount: 7,
      adBypass: true,
    }), reply);
    handleTemporaryAdBypassWrite(activityWrite(12, 1, {
      countedAt: NOW + DAY_MS,
    }), reply);

    jest.setSystemTime(NOW);
    maintainTemporaryAdBypassActivities(reply, NOW);

    const rows: readonly StoredTemporaryAdBypassActivity[] =
      readStoredTemporaryAdBypassActivities(
        requireStorageDatabaseFixture(),
        [7, 8, 9, 10, 11, 12]
      );
    expect(rows.map((row: StoredTemporaryAdBypassActivity): number => row.id))
      .toEqual([8, 9, 12]);
    expect(acknowledgements.at(-1)?.temporaryAdBypassWrites).toHaveLength(6);
  });

  test("零点清理后迟到的前一日未达标写按原 revision 落成墓碑", (): void => {
    maintainTemporaryAdBypassActivities(reply, NOW);

    handleTemporaryAdBypassWrite(activityWrite(7, 1, {
      countedAt: NOW - 1,
    }), reply);
    handleTemporaryAdBypassWrite(activityWrite(8, 1, {
      countedAt: NOW - 1,
      adBypass: true,
    }), reply);
    expect(flushStorageDatabase(reply)).toBeTrue();

    expect(readStoredTemporaryAdBypassActivities(
      requireStorageDatabaseFixture(),
      [7, 8]
    ).map((row: StoredTemporaryAdBypassActivity): number => row.id)).toEqual([8]);
    expect(acknowledgements.at(-1)?.temporaryAdBypassWrites).toEqual([
      { id: 7, revision: 1 },
      { id: 8, revision: 1 },
    ]);
  });

  test("在途事务提交失败时保留累计并拒绝执行日切删除", (): void => {
    jest.setSystemTime(NOW - 1);
    handleTemporaryAdBypassWrite(activityWrite(7, 1, {
      countedAt: NOW - 1,
    }), reply);
    expect(flushStorageDatabase(reply)).toBeTrue();
    jest.setSystemTime(NOW);
    handleTemporaryAdBypassWrite(activityWrite(8, 2), reply);

    closeStorageDatabase(requireStorageDatabaseFixture());
    expect((): void => maintainTemporaryAdBypassActivities(reply, NOW))
      .toThrow("requires all pending writes to be committed");
    expect(pendingTemporaryAdBypassWrites.has(8)).toBeTrue();

    storageDatabaseHandle.current = openStorageDatabase({
      path: IDENTITY_DATABASE_PATH,
    });
    expect(readStoredTemporaryAdBypassActivities(
      requireStorageDatabaseFixture(),
      [7]
    )).toHaveLength(1);
    expect(flushStorageDatabase(reply)).toBeTrue();
  });

});

function requireStorageDatabaseFixture(): StorageDatabase {
  const database: StorageDatabase | null = storageDatabaseHandle.current;
  if (database === null) throw new Error("storage database fixture must be hydrated");
  return database;
}
