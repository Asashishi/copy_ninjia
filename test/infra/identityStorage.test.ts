import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
  IDENTITY_READ_CACHE_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import { DAY_MS } from "../../packages/consts/diskIO/common";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import type {
  DiskBusinessMessage,
  DomainFlushOutcome,
  DiskIORecoveryTransport,
  DiskIORespawnListener,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO";
import type {
  BlocklistIdPage,
  IdentityPolicyRawReadResult,
} from "../../packages/types/identityStorage";
import type {
  RecordedTemporaryWhitelistActivity,
  TemporaryWhitelistActivity,
} from "../../packages/types/temporaryWhitelist";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise: Promise<T> = new Promise<T>((done: (value: T) => void): void => {
    resolve = done;
  });
  return { promise, resolve };
}

const diskMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
const respawnListeners: DiskIORespawnListener[] = [];
let readImplementation: (ids: readonly number[]) => Promise<IdentityPolicyRawReadResult> =
  async (): Promise<IdentityPolicyRawReadResult> => ({
    whitelist: [],
    blocklist: [],
    temporaryWhitelist: [],
  });
let pageReadImplementation: (afterId: number | null) => Promise<BlocklistIdPage> =
  async (afterId: number | null): Promise<BlocklistIdPage> => ({
    ids: [],
    nextCursor: afterId,
    done: true,
  });
const readIdentityPolicies = mock(
  (ids: readonly number[]): Promise<IdentityPolicyRawReadResult> => readImplementation(ids)
);
const readBlocklistIdPage = mock(
  (afterId: number | null): Promise<BlocklistIdPage> =>
    pageReadImplementation(afterId)
);
let acceptDiskMessages: boolean = true;
const flushDiskIODomainOutcome = mock(
  async (domain: "whitelist" | "blocklist"): Promise<DomainFlushOutcome> => {
    const writes: { table: "whitelist" | "blocklist"; id: number; revision: number }[] = [];
    for (const message of diskMessages) {
      if (message.type !== "identityPolicyWrite" || message.table !== domain) continue;
      writes.push({ table: message.table, id: message.id, revision: message.revision });
    }
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes,
        temporaryWhitelistWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    return { result: "flushed" };
  }
);

mock.module("../../packages/infra/diskIO", () => ({
  isDiskIOInitialized: (): boolean => true,
  onDiskIORespawn: (
    _owner: string,
    _priority: number,
    listener: DiskIORespawnListener
  ): void => {
    respawnListeners.push(listener);
  },
  onIdentityStoragePersisted: (
    listener: (reply: IdentityStoragePersistedReply) => void
  ): void => {
    persistedListeners.push(listener);
  },
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskMessages.push(message);
    return acceptDiskMessages;
  },
  flushDiskIODomainOutcome,
  readBlocklistIdPage,
  readIdentityPolicies,
  relayLogMessage: (): boolean => true,
}));

const {
  blocklistEntryCache,
  identityEntryCounts,
  identityWriteRevision,
  resetIdentityStorageCache,
  unacknowledgedBlocklistWrites,
  unacknowledgedWhitelistWrites,
  whitelistEntryCache,
} = await import("../../packages/cache/main/identityStorage");
const {
  temporaryWhitelistActivityCache,
  unacknowledgedTemporaryWhitelistWrites,
} = await import(
  "../../packages/cache/main/temporaryWhitelist"
);
const {
  clearTemporaryWhitelistActivity,
  hasActiveTemporaryWhitelist,
  recordTemporaryWhitelistActivity,
} = await import("../../packages/infra/identityPolicy/temporaryWhitelist");
const {
  cachedBlocklistEntry,
  cachedWhitelistEntry,
  confirmIdentityPolicyPersisted,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
  queueIdentityPolicyWrite,
  readBlocklistSweepPage,
  retainCurrentlyBlockedIdentityIds,
} = await import("../../packages/infra/identityStorage");

function seedMissing(id: number): void {
  blocklistEntryCache.set(id, null);
  whitelistEntryCache.set(id, null);
  temporaryWhitelistActivityCache.set(id, null);
}

function blockValue(blockedAt: string = "2026/08/11 00:00:00") {
  return {
    blockedAt,
    meta: { firstName: "Alice", lastName: "", username: "alice" },
  } as const;
}

beforeEach(() => {
  diskMessages.length = 0;
  acceptDiskMessages = true;
  resetIdentityStorageCache();
  readIdentityPolicies.mockClear();
  readBlocklistIdPage.mockClear();
  flushDiskIODomainOutcome.mockClear();
  readImplementation = async (): Promise<IdentityPolicyRawReadResult> => ({
    whitelist: [],
    blocklist: [],
    temporaryWhitelist: [],
  });
  pageReadImplementation = async (
    afterId: number | null
  ): Promise<BlocklistIdPage> => ({
    ids: [],
    nextCursor: afterId,
    done: true,
  });
});

describe("主线程身份 LRU 与数据库最终一致性", () => {
  test("冷读填充上一东京日已达标的临时白名单正缓存", async () => {
    const now: number = Date.now();
    readImplementation = async (): Promise<IdentityPolicyRawReadResult> => ({
      whitelist: [],
      blocklist: [],
      temporaryWhitelist: [{
        id: 7,
        tempWhite: true,
        tempWhiteAt: now - DAY_MS,
        tempWhiteCount: 7,
        sendCount: 8,
        countedAt: now - DAY_MS,
        qualifiedAt: now - DAY_MS,
      }],
    });

    await expect(prefetchIdentityPolicies([7])).resolves.toBeTrue();
    expect(hasActiveTemporaryWhitelist(7)).toBeTrue();
    await expect(prefetchIdentityPolicies([7])).resolves.toBeTrue();
    expect(readIdentityPolicies).toHaveBeenCalledTimes(1);
  });

  test("临时白名单发言写入按主键保留最新 revision 并由精确 ACK 收敛", () => {
    const now: number = Date.now();
    seedMissing(7);
    expect(recordTemporaryWhitelistActivity(7, now)?.queued).toBeTrue();
    const firstRevision: number = unacknowledgedTemporaryWhitelistWrites.get(7)!.revision;
    expect(recordTemporaryWhitelistActivity(7, now)?.queued).toBeTrue();
    const secondRevision: number = unacknowledgedTemporaryWhitelistWrites.get(7)!.revision;
    expect(unacknowledgedTemporaryWhitelistWrites.get(7)?.activity?.sendCount).toBe(2);

    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        temporaryWhitelistWrites: [{ id: 7, revision: firstRevision }],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedTemporaryWhitelistWrites.get(7)?.revision).toBe(secondRevision);
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        temporaryWhitelistWrites: [{ id: 7, revision: secondRevision }],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedTemporaryWhitelistWrites.has(7)).toBeFalse();

    expect(clearTemporaryWhitelistActivity(7)).toBeTrue();
    expect(temporaryWhitelistActivityCache.peek(7)).toBeNull();
    expect(unacknowledgedTemporaryWhitelistWrites.get(7)?.activity).toBeNull();
  });

  test("当天达标后同日发言不再产生写回，跨日恢复推进", () => {
    const dayAt: number = new Date("2026-08-01T12:00:00+09:00").getTime();
    seedMissing(7);
    for (let index: number = 0; index < 8; index++) {
      expect(recordTemporaryWhitelistActivity(7, dayAt + index)?.queued).toBeTrue();
    }
    const qualified: Readonly<TemporaryWhitelistActivity> | null | undefined =
      temporaryWhitelistActivityCache.peek(7);
    if (qualified === null || qualified === undefined) {
      throw new Error("qualified activity must exist");
    }
    expect(qualified.qualifiedAt).toBe(dayAt + 7);
    const revision: number = unacknowledgedTemporaryWhitelistWrites.get(7)!.revision;
    const queuedWrites: number = diskMessages.length;

    for (let index: number = 8; index < 64; index++) {
      const recorded: RecordedTemporaryWhitelistActivity | undefined =
        recordTemporaryWhitelistActivity(7, dayAt + index);
      expect(recorded?.queued).toBeTrue();
      expect(recorded?.activity).toBe(qualified);
    }
    expect(diskMessages.length).toBe(queuedWrites);
    expect(unacknowledgedTemporaryWhitelistWrites.get(7)?.revision).toBe(revision);
    expect(temporaryWhitelistActivityCache.peek(7)).toBe(qualified);

    // 跨东京日的第一条发言仍然重置当日累计并落盘。
    const nextDayAt: number = dayAt + DAY_MS;
    expect(recordTemporaryWhitelistActivity(7, nextDayAt)?.activity).toMatchObject({
      tempWhite: true,
      tempWhiteCount: 1,
      sendCount: 1,
      countedAt: nextDayAt,
      qualifiedAt: null,
    });
    expect(diskMessages.length).toBe(queuedWrites + 1);
    for (let index: number = 1; index < 8; index++) {
      expect(recordTemporaryWhitelistActivity(7, nextDayAt + index)?.queued).toBeTrue();
    }
    expect(temporaryWhitelistActivityCache.peek(7)).toMatchObject({
      tempWhiteCount: 2,
      sendCount: 8,
      qualifiedAt: nextDayAt + 7,
    });
    expect(diskMessages.length).toBe(queuedWrites + 8);
  });

  test("广告 true 清理在冷读失败窗口仍发布可重放墓碑", () => {
    expect(temporaryWhitelistActivityCache.has(7)).toBeFalse();

    expect(clearTemporaryWhitelistActivity(7)).toBeTrue();

    expect(temporaryWhitelistActivityCache.peek(7)).toBeNull();
    expect(unacknowledgedTemporaryWhitelistWrites.get(7)).toEqual({
      activity: null,
      revision: 1,
    });
    expect(diskMessages.at(-1)).toEqual({
      type: "temporaryWhitelistWrite",
      id: 7,
      activity: null,
      revision: 1,
    });
  });

  test("未 ACK 最终值覆盖迟到数据库冷读，不能把新拉黑回滚成负缓存", async () => {
    const pendingRead: Deferred<IdentityPolicyRawReadResult> = deferred();
    readImplementation = async (): Promise<IdentityPolicyRawReadResult> => pendingRead.promise;
    const loading: Promise<boolean> = prefetchIdentityPolicies([7]);
    await Bun.sleep(0);

    seedMissing(7);
    queueIdentityPolicyWrite("blocklist", 7, blockValue());
    pendingRead.resolve({ whitelist: [], blocklist: [], temporaryWhitelist: [] });
    await loading;

    expect(cachedBlocklistEntry(7)?.meta.username).toBe("alice");
    expect(unacknowledgedBlocklistWrites.has(7)).toBeTrue();
  });

  test("写入与删除先同步两份内存结论，ACK 前后重复读取都不回查数据库", async () => {
    seedMissing(7);
    queueIdentityPolicyWrite("blocklist", 7, blockValue());

    expect(cachedBlocklistEntry(7)?.meta.username).toBe("alice");
    expect(isIdentityPolicyCached(7)).toBeTrue();
    await prefetchIdentityPolicies([7]);
    expect(readIdentityPolicies).not.toHaveBeenCalled();

    const writeRevision: number = unacknowledgedBlocklistWrites.get(7)!.revision;
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [{ table: "blocklist", id: 7, revision: writeRevision }],
        temporaryWhitelistWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedBlocklistWrites.has(7)).toBeFalse();
    expect(cachedBlocklistEntry(7)?.meta.username).toBe("alice");
    await prefetchIdentityPolicies([7]);
    expect(readIdentityPolicies).not.toHaveBeenCalled();

    queueIdentityPolicyWrite("blocklist", 7, null);
    expect(cachedBlocklistEntry(7)).toBeUndefined();
    expect(isIdentityPolicyCached(7)).toBeTrue();
    await prefetchIdentityPolicies([7]);
    expect(readIdentityPolicies).not.toHaveBeenCalled();
  });

  test("旧 ACK 不删除较新的同主键 revision，精确 ACK 才收敛", () => {
    seedMissing(7);
    queueIdentityPolicyWrite("blocklist", 7, blockValue("2026/08/11 00:00:00"));
    const firstRevision: number = unacknowledgedBlocklistWrites.get(7)!.revision;
    queueIdentityPolicyWrite("blocklist", 7, blockValue("2026/08/11 00:00:01"));
    const secondRevision: number = unacknowledgedBlocklistWrites.get(7)!.revision;

    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [{ table: "blocklist", id: 7, revision: firstRevision }],
        temporaryWhitelistWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedBlocklistWrites.get(7)?.revision).toBe(secondRevision);
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [{ table: "blocklist", id: 7, revision: secondRevision }],
        temporaryWhitelistWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedBlocklistWrites.has(7)).toBeFalse();
  });

  test("白名单事务确认等待精确 ACK，幂等重试会补投缓存里的未确认最终值", async () => {
    seedMissing(7);
    acceptDiskMessages = false;
    expect(queueIdentityPolicyWrite("whitelist", 7, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toBeFalse();
    expect(diskMessages).toHaveLength(1);

    acceptDiskMessages = true;
    await expect(confirmIdentityPolicyPersisted("whitelist", 7, true))
      .resolves.toBeUndefined();

    expect(diskMessages).toHaveLength(2);
    expect(flushDiskIODomainOutcome).toHaveBeenCalledWith("whitelist");
    expect(unacknowledgedWhitelistWrites.has(7)).toBeFalse();
  });

  test("领域 flush 声称成功但缺少目标精确 ACK 时仍拒绝收敛缓存", async () => {
    seedMissing(7);
    expect(queueIdentityPolicyWrite("whitelist", 7, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toBeTrue();
    flushDiskIODomainOutcome.mockImplementationOnce(
      async (): Promise<DomainFlushOutcome> => ({ result: "flushed" })
    );

    await expect(confirmIdentityPolicyPersisted("whitelist", 7, false))
      .rejects.toThrow("did not acknowledge");
    expect(diskMessages).toHaveLength(1);
    expect(unacknowledgedWhitelistWrites.has(7)).toBeTrue();
  });

  test("revision 耗尽在发布缓存之前失败，不留下无法重放的半份状态", () => {
    seedMissing(7);
    identityWriteRevision.current = Number.MAX_SAFE_INTEGER;

    expect(() => queueIdentityPolicyWrite("whitelist", 7, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toThrow("revision space is exhausted");

    expect(whitelistEntryCache.peek(7)).toBeNull();
    expect(identityEntryCounts.whitelist).toBe(0);
    expect(unacknowledgedWhitelistWrites.has(7)).toBeFalse();
    expect(diskMessages).toEqual([]);
  });

  test("DiskIO Worker 重建只重放每个主键最新未 ACK 最终值", async () => {
    seedMissing(7);
    queueIdentityPolicyWrite("blocklist", 7, blockValue("2026/08/11 00:00:00"));
    queueIdentityPolicyWrite("blocklist", 7, blockValue("2026/08/11 00:00:02"));
    const replayed: DiskBusinessMessage[] = [];
    const transport: DiskIORecoveryTransport = {
      post(message: DiskBusinessMessage): boolean {
        replayed.push(message);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("not used");
      },
    };

    for (const listener of respawnListeners) expect(await listener(transport)).toBeTrue();
    expect(replayed).toEqual([expect.objectContaining({
      type: "identityPolicyWrite",
      table: "blocklist",
      id: 7,
      revision: unacknowledgedBlocklistWrites.get(7)!.revision,
    })]);
  });

  test("Worker 重建把已经失效的临时白名单重放归一化为墓碑", async () => {
    const staleAt: number = Date.now() - 2 * DAY_MS;
    seedMissing(7);
    for (let index: number = 0; index < 8; index++) {
      expect(recordTemporaryWhitelistActivity(7, staleAt + index)?.queued).toBeTrue();
    }
    expect(unacknowledgedTemporaryWhitelistWrites.get(7)?.activity?.tempWhite)
      .toBeTrue();

    const replayed: DiskBusinessMessage[] = [];
    const transport: DiskIORecoveryTransport = {
      post(message: DiskBusinessMessage): boolean {
        replayed.push(message);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("not used");
      },
    };

    for (const listener of respawnListeners) expect(await listener(transport)).toBeTrue();
    expect(replayed).toEqual([expect.objectContaining({
      type: "temporaryWhitelistWrite",
      id: 7,
      activity: null,
    })]);
    expect(unacknowledgedTemporaryWhitelistWrites.get(7)?.activity).toBeNull();
    expect(temporaryWhitelistActivityCache.peek(7)).toBeNull();
  });

  test("黑转白在 Worker 重建后仍按全局 revision 先删后增", async () => {
    seedMissing(7);
    queueIdentityPolicyWrite("blocklist", 7, blockValue());
    queueIdentityPolicyWrite("blocklist", 7, null);
    queueIdentityPolicyWrite("whitelist", 7, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    });
    const replayed: DiskBusinessMessage[] = [];
    const transport: DiskIORecoveryTransport = {
      post(message: DiskBusinessMessage): boolean {
        replayed.push(message);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("not used");
      },
    };

    for (const listener of respawnListeners) expect(await listener(transport)).toBeTrue();
    expect(replayed).toEqual([
      expect.objectContaining({
        type: "identityPolicyWrite",
        table: "blocklist",
        id: 7,
        data: null,
      }),
      expect.objectContaining({
        type: "identityPolicyWrite",
        table: "whitelist",
        id: 7,
      }),
    ]);
    const first: DiskBusinessMessage = replayed[0]!;
    const second: DiskBusinessMessage = replayed[1]!;
    if (first.type !== "identityPolicyWrite" || second.type !== "identityPolicyWrite") {
      throw new Error("Expected identity policy replay messages.");
    }
    expect(first.revision).toBeLessThan(second.revision);
  });

  test("三份正/负 LRU 各自严格限制为 IDENTITY_READ_CACHE_MAX_ENTRIES 项", () => {
    for (let id: number = 1; id <= IDENTITY_READ_CACHE_MAX_ENTRIES + 1; id++) {
      blocklistEntryCache.set(id, null);
      whitelistEntryCache.set(id, null);
      temporaryWhitelistActivityCache.set(id, null);
    }
    expect(blocklistEntryCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);
    expect(whitelistEntryCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);
    expect(temporaryWhitelistActivityCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);
    expect(blocklistEntryCache.has(1)).toBeFalse();
    expect(whitelistEntryCache.has(1)).toBeFalse();
    expect(temporaryWhitelistActivityCache.has(1)).toBeFalse();
  });

  test("长时间取键流转下临时白名单只保留有界现场，Worker 重建按 revision 重放", async () => {
    const dayAt: number = new Date("2026-08-01T12:00:00+09:00").getTime();
    const churn: number = IDENTITY_READ_CACHE_MAX_ENTRIES * 2;

    // 每个身份只发一条：LRU 按容量淘汰，未 ACK 表随精确回执清空。
    let queued: number = 0;
    for (let id: number = 1; id <= churn; id++) {
      temporaryWhitelistActivityCache.set(id, null);
      if (recordTemporaryWhitelistActivity(id, dayAt)?.queued === true) queued++;
    }
    expect(queued).toBe(churn);
    expect(temporaryWhitelistActivityCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);
    expect(temporaryWhitelistActivityCache.has(1)).toBeFalse();
    expect(unacknowledgedTemporaryWhitelistWrites.size).toBe(churn);

    const settled: { id: number; revision: number }[] = [];
    for (const [id, write] of unacknowledgedTemporaryWhitelistWrites) {
      settled.push({ id, revision: write.revision });
    }
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        temporaryWhitelistWrites: settled,
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedTemporaryWhitelistWrites.size).toBe(0);
    expect(temporaryWhitelistActivityCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);

    // 达标稳态不再产生任何未 ACK 现场：连续发言只走热度刷新。
    const steady: number = churn;
    for (let index: number = 1; index < 8; index++) {
      recordTemporaryWhitelistActivity(steady, dayAt + index);
    }
    const qualifiedRevision: number =
      unacknowledgedTemporaryWhitelistWrites.get(steady)!.revision;
    let frozen: number = 0;
    for (let index: number = 8; index < 512; index++) {
      if (recordTemporaryWhitelistActivity(steady, dayAt + index)?.queued === true) frozen++;
    }
    expect(frozen).toBe(504);
    expect(unacknowledgedTemporaryWhitelistWrites.size).toBe(1);
    expect(unacknowledgedTemporaryWhitelistWrites.get(steady)?.revision)
      .toBe(qualifiedRevision);

    const replayed: DiskBusinessMessage[] = [];
    const transport: DiskIORecoveryTransport = {
      post(message: DiskBusinessMessage): boolean {
        replayed.push(message);
        return true;
      },
      ensureLuckReceiptSecret: async (): Promise<never> => {
        throw new Error("not used");
      },
    };
    for (const listener of respawnListeners) expect(await listener(transport)).toBeTrue();
    expect(replayed).toEqual([expect.objectContaining({
      type: "temporaryWhitelistWrite",
      id: steady,
      revision: qualifiedRevision,
    })]);
  });

  test("一次更新的超大身份集合按预取分块上限分成有界数据库读", async () => {
    const ids: number[] = [];
    for (let id: number = 1; id <= IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 1; id++) ids.push(id);
    await expect(prefetchIdentityPolicies(ids)).resolves.toBeTrue();
    expect(readIdentityPolicies).toHaveBeenCalledTimes(2);
    expect(readIdentityPolicies.mock.calls[0]![0]).toHaveLength(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
    expect(readIdentityPolicies.mock.calls[1]![0]).toHaveLength(1);
  });

  test("分块步长严格小于 LRU 容量，同一次预取的前一块不会被后一块整块驱逐", () => {
    // 相等时 /batch_kick 那种上万条的批量预取只剩最后一块是热的，被挤掉的白名单
    // 管理员会按冷未命中判成普通成员踢出去（见 commands/batchKick.ts）。
    expect(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES)
      .toBeLessThan(IDENTITY_READ_CACHE_MAX_ENTRIES);
  });

  test("补扫每页先等待黑名单精确 ACK，再以该页游标读取 SQLite", async () => {
    seedMissing(7);
    queueIdentityPolicyWrite("blocklist", 7, blockValue());
    pageReadImplementation = async (): Promise<BlocklistIdPage> => ({
      ids: [7],
      nextCursor: 7,
      done: true,
    });

    await expect(readBlocklistSweepPage(null)).resolves.toEqual({
      ids: [7],
      nextCursor: 7,
      done: true,
    });

    expect(flushDiskIODomainOutcome).toHaveBeenCalledWith("blocklist");
    expect(unacknowledgedBlocklistWrites.size).toBe(0);
    expect(readBlocklistIdPage).toHaveBeenCalledWith(null);
  });

  test("flush 没有精确 ACK 时拒绝开始补扫，不拿数据库旧页继续", async () => {
    seedMissing(7);
    queueIdentityPolicyWrite("blocklist", 7, blockValue());
    flushDiskIODomainOutcome.mockImplementationOnce(
      async (): Promise<DomainFlushOutcome> => ({ result: "flushed" })
    );

    await expect(readBlocklistSweepPage(null))
      .rejects.toThrow("unacknowledged write");
    expect(readBlocklistIdPage).not.toHaveBeenCalled();
  });

  test("durable 对账只复核当前有界页，未 ACK 最终值覆盖数据库迟到结果", async () => {
    for (const id of [7, 8, 9]) seedMissing(id);
    queueIdentityPolicyWrite("blocklist", 7, null);
    queueIdentityPolicyWrite("blocklist", 9, blockValue());
    readImplementation = async (): Promise<IdentityPolicyRawReadResult> => ({
      whitelist: [],
      blocklist: [[7, "{}"], [8, "{}"]],
      temporaryWhitelist: [],
    });

    await expect(retainCurrentlyBlockedIdentityIds([7, 8, 9]))
      .resolves.toEqual([8, 9]);
  });

  test("冷读失败就地降级为「仍是冷的」，不把异常抛给 update 前置中间件", async () => {
    readImplementation = async (): Promise<IdentityPolicyRawReadResult> => {
      throw new Error("Persistence Worker is unavailable; cannot read identity policies.");
    };
    await expect(prefetchIdentityPolicies([4_242])).resolves.toBeFalse();
    expect(cachedWhitelistEntry(4_242)).toBeUndefined();
    expect(cachedBlocklistEntry(4_242)).toBeUndefined();
  });
});
