import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { STORAGE_PENDING_MAX_ENTRIES, STORAGE_PENDING_MAX_BYTES, STORAGE_WRITE_MAX_FAILURES } from "../../../packages/consts/diskIO/business";
import { IDENTITY_DATABASE_PATH } from "../../../packages/consts/paths";
import { pendingTemporaryWhitelistWrites, resetStorageDatabaseCache, storageDatabaseHandle, storageWriteFatalReply, storageWriteRetry } from "../../../packages/cache/workers/diskIO/storageDatabase";
import { openStorageDatabase } from "../../../packages/database/interact/connection";
import { clearStorageBusinessTables } from "../../../scripts/fixtures/storageDatabase";
import { handleTemporaryWhitelistWrite } from "../../../packages/workers/diskIO/storageDatabase/temporaryWhitelist";
import { flushStorageDatabase } from "../../../packages/workers/diskIO/storageDatabase/flush";
import { StorageWriteBudget, storageWriteCost } from "../../../packages/libs/storageWriteBudget";
import type { IdentityStoragePersistedReply } from "../../../packages/types/diskIO/replies";
const acks: IdentityStoragePersistedReply[] = [];
function reply(value: IdentityStoragePersistedReply): void { acks.push(value); }
let errors: ReturnType<typeof spyOn>;
beforeEach((): void => {
  resetStorageDatabaseCache(); acks.length = 0;
  storageDatabaseHandle.current = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  clearStorageBusinessTables(storageDatabaseHandle.current);
  errors = spyOn(console, "error").mockImplementation((): void => undefined);
});
afterEach((): void => { resetStorageDatabaseCache(); storageWriteFatalReply.current = null; errors.mockRestore(); });

test("SQLite 只读时容量内输入只触发一次自动提交；容量拒绝不删除原批", (): void => {
  storageDatabaseHandle.current!.$client.run("PRAGMA query_only = ON");
  for (let id: number = 1; id <= STORAGE_PENDING_MAX_ENTRIES; id++) {
    handleTemporaryWhitelistWrite({ type: "temporaryWhitelistWrite", id, activity: null, revision: id }, reply);
  }
  expect(storageWriteRetry.failures).toBe(1); expect(acks).toHaveLength(0);
  expect(pendingTemporaryWhitelistWrites.size).toBe(STORAGE_PENDING_MAX_ENTRIES);
  expect((): void => handleTemporaryWhitelistWrite({ type: "temporaryWhitelistWrite", id: STORAGE_PENDING_MAX_ENTRIES + 1, activity: null, revision: 1 }, reply)).toThrow("capacity");
  let fatalCount: number = 0; storageWriteFatalReply.current = (): void => { fatalCount++; };
  for (let index: number = 1; index < STORAGE_WRITE_MAX_FAILURES; index++) expect(flushStorageDatabase(reply)).toBeFalse();
  expect(fatalCount).toBe(1); expect(acks).toHaveLength(0);
  storageDatabaseHandle.current!.$client.run("PRAGMA query_only = OFF");
  expect(flushStorageDatabase(reply)).toBeTrue();
  expect(acks[0]!.temporaryWhitelistWrites).toHaveLength(STORAGE_PENDING_MAX_ENTRIES);
  expect(pendingTemporaryWhitelistWrites.size).toBe(0);
});

test("同步事务 ACK 回调创建的新写入属于下一批", (): void => {
  handleTemporaryWhitelistWrite({ type: "temporaryWhitelistWrite", id: 1, activity: null, revision: 1 }, reply);
  expect(flushStorageDatabase((value: IdentityStoragePersistedReply): void => {
    reply(value);
    handleTemporaryWhitelistWrite({ type: "temporaryWhitelistWrite", id: 1, activity: null, revision: 2 }, reply);
  })).toBeTrue();
  expect(acks[0]!.temporaryWhitelistWrites).toEqual([{ id: 1, revision: 1 }]);
  expect(pendingTemporaryWhitelistWrites.get(1)?.revision).toBe(2);
  expect(flushStorageDatabase(reply)).toBeTrue();
  expect(acks[1]!.temporaryWhitelistWrites).toEqual([{ id: 1, revision: 2 }]);
});

test("字节与条目预算独立生效；拒绝、替换和 reset 不泄漏额度", (): void => {
  const budget: StorageWriteBudget = new StorageWriteBudget();
  budget.reserve(1, STORAGE_PENDING_MAX_BYTES);
  expect((): void => budget.reserve(0, 1)).toThrow("capacity");
  budget.reserve(0, storageWriteCost(null) - STORAGE_PENDING_MAX_BYTES);
  budget.reserve(STORAGE_PENDING_MAX_ENTRIES - 1, 0);
  expect((): void => budget.reserve(1, 0)).toThrow("capacity");
  budget.reset(); budget.reserve(1, STORAGE_PENDING_MAX_BYTES);
});

test("自动重试按截止退避，连续失败达到上限后停止自动提交并只通知一次", async (): Promise<void> => {
  const { jest } = await import("bun:test");
  const { configureStoragePersistenceReply } = await import("../../../packages/workers/diskIO/storageDatabase/flush");
  const { storageWriteFlushTimer } = await import("../../../packages/cache/workers/diskIO/storageDatabase");
  jest.useFakeTimers();
  try {
    configureStoragePersistenceReply(reply);
    let fatalCount: number = 0; storageWriteFatalReply.current = (): void => { fatalCount++; };
    storageDatabaseHandle.current!.$client.run("PRAGMA query_only = ON");
    for (let id: number = 1; id <= 128; id++) handleTemporaryWhitelistWrite({ type: "temporaryWhitelistWrite", id, activity: null, revision: 1 }, reply);
    expect(storageWriteRetry.failures).toBe(1);
    jest.advanceTimersByTime(30_000);
    expect(storageWriteRetry.failures).toBe(2);
    jest.advanceTimersByTime(59_999);
    expect(storageWriteRetry.failures).toBe(2);
    jest.advanceTimersByTime(1);
    expect(storageWriteRetry.failures).toBe(STORAGE_WRITE_MAX_FAILURES);
    expect(fatalCount).toBe(1); expect(storageWriteFlushTimer.current).toBeNull();
    expect(pendingTemporaryWhitelistWrites.size).toBe(128); expect(acks).toHaveLength(0);
  } finally { jest.useRealTimers(); }
});
