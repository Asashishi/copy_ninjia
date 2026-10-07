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
  rejectedStorageDomains,
  pendingChatQaWrites,
  storagePersistenceReplyHolder,
  storageWriteFlushTimer,
} from "../../../packages/cache/workers/diskIO/storageDatabase";
import {
  flushStorageDatabase,
  collectStorageDatabaseFailures,
} from "../../../packages/workers/diskIO/storageDatabase/flush";
import { hydrateStorageDatabase } from "../../helpers/storageDatabaseHydration";
import { handleIdentityPolicyWrite } from
  "../../../packages/workers/diskIO/storageDatabase/identityPolicy";
import { handlePendingRemovalSnapshot } from
  "../../../packages/workers/diskIO/storageDatabase/pendingRemoval";
import type {
  DiskIODomain,
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

    storagePersistenceReplyHolder.current = reply;
    jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);

    expect(storageWriteFlushTimer.current).toBeNull();
    expect(pendingWhitelistWrites).toHaveLength(0);
    expect(acknowledgements).toEqual([{
      type: "identityStoragePersisted",
      writes: [
        { table: "whitelist", id: 7, revision: 1 },
        { table: "whitelist", id: 8, revision: 1 },
      ],
      temporaryAdBypassWrites: [],
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
      temporaryAdBypassWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
    }]);

    resetStorageDatabaseCache();
    expect(hydrateStorageDatabase().permissionEntryCount).toBe(1);
  });

  test("节拍到点时提交仍然失败：点名记一行并重排下一拍，不丢最终值", (): void => {
    // 提交失败时重排下一拍：定时器已自清，dirty 标记保留，最终值留在内存等下一拍。
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      jest.useFakeTimers();
      handleIdentityPolicyWrite(whitelistWrite(11, 6), reply);
      storagePersistenceReplyHolder.current = reply;
      closeStorageDatabase(storageDatabaseHandle.current!);

      jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith("[diskIOWorker] storage database transaction failed:", expect.any(Error));
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
    // 取走即清空拒收标记，该领域此后的 flush 不再回报失败。
    rejectedStorageDomains.add("blocklistRemovalOutbox");
    handleIdentityPolicyWrite(whitelistWrite(12, 7), reply);
    pendingChatQaWrites.set(-1001, new Map([["问", { answer: "答", revision: 1 }]]) as never);

    const first: DiskIODomain[] = [];
    collectStorageDatabaseFailures(null, first);
    expect(new Set(first)).toEqual(new Set(["blocklistRemovalOutbox", "whitelist", "chatQa"]));

    // 取走一次之后拒收标记不再复现；仍 dirty 的表照旧上报。
    const second: DiskIODomain[] = [];
    collectStorageDatabaseFailures(null, second);
    expect(new Set(second)).toEqual(new Set(["whitelist", "chatQa"]));
  });

  test("单领域屏障只取走本领域的拒收标记，别的领域留给它自己的屏障回报", (): void => {
    rejectedStorageDomains.add("chatState");
    rejectedStorageDomains.add("whitelist");
    handleIdentityPolicyWrite(whitelistWrite(13, 8), reply);

    expect(flushStorageDatabase(reply)).toBeTrue();
    const whitelistBarrier: DiskIODomain[] = [];
    collectStorageDatabaseFailures("whitelist", whitelistBarrier);
    expect(whitelistBarrier).toEqual(["whitelist"]);

    // whitelist 屏障不带走 chatState 的拒收，该失败由 chatState 屏障回报。
    const chatStateBarrier: DiskIODomain[] = [];
    collectStorageDatabaseFailures("chatState", chatStateBarrier);
    expect(chatStateBarrier).toEqual(["chatState"]);
    const again: DiskIODomain[] = [];
    collectStorageDatabaseFailures(null, again);
    expect(again).toEqual([]);
  });

  test("事务提交成功而另有拒收标记时，提交结果仍报成功，定时节拍不记失败", (): void => {
    const error = spyOn(console, "error").mockImplementation((): void => {});
    try {
      jest.useFakeTimers();
      rejectedStorageDomains.add("chatQa");
      handleIdentityPolicyWrite(whitelistWrite(14, 9), reply);
      storagePersistenceReplyHolder.current = reply;

      jest.advanceTimersByTime(IDENTITY_WRITE_FLUSH_INTERVAL_MS);

      expect(pendingWhitelistWrites).toHaveLength(0);
      expect(error).not.toHaveBeenCalled();
      const failedDomains: DiskIODomain[] = [];
      collectStorageDatabaseFailures(null, failedDomains);
      expect(failedDomains).toEqual(["chatQa"]);
    } finally {
      error.mockRestore();
    }
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
      temporaryAdBypassWrites: [],
      chatStateWrites: [],
      chatQaWrites: [],
      removalSnapshotRevision: 5,
    }]);

    expect(flushStorageDatabase(reply)).toBeTrue();
    expect(acknowledgements).toHaveLength(1);
  });
});
