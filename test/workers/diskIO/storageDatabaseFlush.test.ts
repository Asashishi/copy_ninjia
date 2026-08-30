import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import {
  IDENTITY_WRITE_FLUSH_INTERVAL_MS,
} from "../../../packages/consts/identityStorage";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../../packages/consts/whitelist";
import { encodeWhitelistEntryData } from
  "../../../packages/database/codec/identity";
import { clearStorageBusinessTables } from
  "../../../scripts/fixtures/storageDatabase";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../../../packages/database/interact/connection";
import {
  latestRemovalSnapshotRevision,
  pendingRemovalSnapshotRevision,
  pendingWhitelistWrites,
  resetStorageDatabaseCache,
  storageDatabaseHandle,
  noteStorageWriteRejected,
  pendingChatQaWrites,
  storagePersistenceReplyHolder,
  storageWriteFlushTimer,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import {
  configureStoragePersistenceReply,
  flushStorageDatabase,
  pendingStorageDatabaseDomains,
} from "../../../packages/workers/diskIO/storageDatabase/flush";
import { hydrateStorageDatabase } from
  "../../../packages/workers/diskIO/storageDatabase/hydration";
import { handleIdentityPolicyWrite } from
  "../../../packages/workers/diskIO/storageDatabase/identityPolicy";
import { handlePendingRemovalSnapshot } from
  "../../../packages/workers/diskIO/storageDatabase/pendingRemoval";
import type {
  IdentityPolicyWriteDiskMessage,
  IdentityStoragePersistedReply,
} from "../../../packages/types/diskIO";
import type { WhitelistEntryData } from
  "../../../packages/types/identityPolicy";
import type { StorageDatabase } from
  "../../../packages/types/storageDatabase";

const META: Readonly<{ firstName: string; lastName: string; username: string }> = {
  firstName: "本天才才不是雑魚喵~",
  lastName: "",
  username: "copy_ninjia_bot",
};
const acknowledgements: IdentityStoragePersistedReply[] = [];

function reply(value: IdentityStoragePersistedReply): void {
  acknowledgements.push(value);
}

function whitelistWrite(id: number, revision: number): IdentityPolicyWriteDiskMessage {
  const value: WhitelistEntryData = {
    permissions: DEFAULT_WHITELIST_PERMISSIONS,
    meta: META,
  };
  return {
    type: "identityPolicyWrite",
    table: "whitelist",
    id,
    data: encodeWhitelistEntryData(value),
    revision,
  };
}

function resetDatabaseFixture(): void {
  resetStorageDatabaseCache();
  const database: StorageDatabase = openStorageDatabase({
    path: IDENTITY_DATABASE_PATH,
  });
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

describe("DiskIO Worker SQLite 定时提交与失败重试", (): void => {
  test("首条 dirty 只建一个 unref timer，ACK 通道恢复后原批只提交一次", (): void => {
    jest.useFakeTimers();

    handleIdentityPolicyWrite(whitelistWrite(7, 1), reply);
    const firstTimer: ReturnType<typeof setTimeout> | null =
      storageWriteFlushTimer.current;
    expect(firstTimer).not.toBeNull();
    expect(firstTimer?.hasRef()).toBeFalse();

    handleIdentityPolicyWrite(whitelistWrite(8, 1), reply);
    expect(storageWriteFlushTimer.current).toBe(firstTimer);

    jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);
    const retryTimer: ReturnType<typeof setTimeout> | null =
      storageWriteFlushTimer.current;
    expect(retryTimer).not.toBeNull();
    expect(retryTimer).not.toBe(firstTimer);
    expect(retryTimer?.hasRef()).toBeFalse();
    expect(pendingWhitelistWrites).toHaveLength(2);
    expect(acknowledgements).toHaveLength(0);

    configureStoragePersistenceReply(reply);
    jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);

    expect(storageWriteFlushTimer.current).toBeNull();
    expect(pendingWhitelistWrites).toHaveLength(0);
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [
        { table: "whitelist", id: 7, revision: 1 },
        { table: "whitelist", id: 8, revision: 1 },
      ],
      temporaryWhitelistWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
    }]);
  });

  test("真实 SQLite 事务失败保留最终值并重排，连接恢复后再 durable ACK", (): void => {
    handleIdentityPolicyWrite(whitelistWrite(9, 4), reply);
    const failedDatabase: StorageDatabase | null = storageDatabaseHandle.current;
    expect(failedDatabase).not.toBeNull();
    closeStorageDatabase(failedDatabase!);

    expect(flushStorageDatabase(reply)).toBeFalse();
    expect(pendingWhitelistWrites.get(9)?.revision).toBe(4);
    expect(storageWriteFlushTimer.current).not.toBeNull();
    expect(acknowledgements).toHaveLength(0);

    storageDatabaseHandle.current = openStorageDatabase({
      path: IDENTITY_DATABASE_PATH,
    });
    expect(flushStorageDatabase(reply)).toBeTrue();
    expect(storageWriteFlushTimer.current).toBeNull();
    expect(pendingWhitelistWrites).toHaveLength(0);
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [{ table: "whitelist", id: 9, revision: 4 }],
      temporaryWhitelistWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
    }]);

    resetStorageDatabaseCache();
    expect(hydrateStorageDatabase().whitelistEntryCount).toBe(1);
  });

  test("节拍到点时提交仍然失败：点名记一行并重排下一拍，不丢最终值", (): void => {
    // 没有这一次重排，一次瞬时的 SQLite 故障就会让这批最终值永远停在内存里：
    // 定时器已经自清，而 dirty 标记只在下一条写入到达时才会重新建表。
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      jest.useFakeTimers();
      handleIdentityPolicyWrite(whitelistWrite(11, 6), reply);
      configureStoragePersistenceReply(reply);
      closeStorageDatabase(storageDatabaseHandle.current!);

      jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);

      expect(error).toHaveBeenCalledWith(
        "[diskIOWorker] failed to flush the storage database; retaining pending changes for retry."
      );
      expect(storageWriteFlushTimer.current).not.toBeNull();
      expect(pendingWhitelistWrites.get(11)?.revision).toBe(6);
      expect(acknowledgements).toHaveLength(0);
    } finally {
      error.mockRestore();
      // 句柄已经被关掉，afterEach 的 reset 不能再去关第二次。
      storageDatabaseHandle.current = null;
    }
  });

  test("失败领域取走即清空：拒收标记与本轮仍 dirty 的表合并上报一次", (): void => {
    // 拒收标记不清空的话，那个领域会在此后每一次 flush 都被回报成失败，
    // 停机排空于是永远等不到「全部落盘」。
    noteStorageWriteRejected("blocklistRemovalOutbox");
    handleIdentityPolicyWrite(whitelistWrite(12, 7), reply);
    pendingChatQaWrites.set(-1001, new Map([["问", { answer: "答", revision: 1 }]]) as never);

    expect(new Set(pendingStorageDatabaseDomains()))
      .toEqual(new Set(["blocklistRemovalOutbox", "whitelist", "chatQa"]));

    // 取走一次之后拒收标记不再复现；仍 dirty 的表照旧上报。
    expect(new Set(pendingStorageDatabaseDomains()))
      .toEqual(new Set(["whitelist", "chatQa"]));
  });

  test("空 outbox 的新 revision 当场 ACK，后续 flush 不重复确认", (): void => {
    handlePendingRemovalSnapshot({
      type: "blocklistRemovals",
      removals: [],
      revision: 5,
    }, reply);

    expect(latestRemovalSnapshotRevision.current).toBe(5);
    expect(pendingRemovalSnapshotRevision.current).toBeNull();
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [],
      temporaryWhitelistWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
      removalSnapshotRevision: 5,
    }]);

    expect(flushStorageDatabase(reply)).toBeTrue();
    expect(acknowledgements).toHaveLength(1);
  });
});
