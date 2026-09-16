import type { DiskIODomain } from "../../packages/types/diskIO/replies";
import { diskIOStub } from "../helpers/diskIOMock";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BLOCKLIST_SWEEP_PAGE_SIZE,
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
  RecordedTemporaryAdBypassActivity,
  TemporaryAdBypassActivity,
} from "../../packages/types/temporaryAdBypass";

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
    temporaryAdBypass: [],
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
  async (domain: DiskIODomain): Promise<DomainFlushOutcome> => {
    const writes: { table: "whitelist" | "blocklist"; id: number; revision: number }[] = [];
    for (const message of diskMessages) {
      if (message.type !== "identityPolicyWrite" || message.table !== domain) continue;
      writes.push({ table: message.table, id: message.id, revision: message.revision });
    }
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes,
        temporaryAdBypassWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    return { result: "flushed" };
  }
);

mock.module("../../packages/infra/diskIO", () => (diskIOStub({
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
})));

const {
  blocklistEntryCache,
  identityEntryCounts,
  identityWriteRevision,
  resetIdentityStorageCache,
  unacknowledgedBlocklistWrites,
  unacknowledgedWhitelistWrites,
  unacknowledgedIdentityBytes,
  whitelistEntryCache,
} = await import("../../packages/cache/main/identityStorage");
const {
  temporaryAdBypassActivityCache,
  unacknowledgedTemporaryAdBypassWrites,
} = await import(
  "../../packages/cache/main/temporaryAdBypass"
);
const {
  clearTemporaryAdBypassActivity,
  hasActiveTemporaryAdBypass,
  recordTemporaryAdBypassActivity,
} = await import("../../packages/infra/identityPolicy/temporaryAdBypass");
const {
  cachedBlocklistEntry,
  cachedWhitelistEntry,
  confirmIdentityPolicyPersisted,
  hasAnyBlockedIdentity,
  hydrateIdentityStorageCounts,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
  queueIdentityPolicyWrite,
  readBlocklistSweepPage,
  retainCurrentlyBlockedIdentityIds,
} = await import("../../packages/infra/identityStorage");

function seedMissing(id: number): void {
  blocklistEntryCache.set(id, null);
  whitelistEntryCache.set(id, null);
  temporaryAdBypassActivityCache.set(id, null);
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
    temporaryAdBypass: [],
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
  test("冷读填充上一东京日已达标的临时广告免检正缓存", async () => {
    const now: number = Date.now();
    readImplementation = async (): Promise<IdentityPolicyRawReadResult> => ({
      whitelist: [],
      blocklist: [],
      temporaryAdBypass: [{
        id: 7,
        adBypass: true,
        adBypassGrantedAt: now - DAY_MS,
        qualifiedDays: 7,
        sendCount: 8,
        countedAt: now - DAY_MS,
        qualifiedAt: now - DAY_MS,
      }],
    });

    await expect(prefetchIdentityPolicies([7])).resolves.toBeTrue();
    expect(hasActiveTemporaryAdBypass(7)).toBeTrue();
    await expect(prefetchIdentityPolicies([7])).resolves.toBeTrue();
    expect(readIdentityPolicies).toHaveBeenCalledTimes(1);
  });

  test("临时广告免检发言写入按主键保留最新 revision 并由精确 ACK 收敛", () => {
    const now: number = Date.now();
    seedMissing(7);
    expect(recordTemporaryAdBypassActivity(7, now)?.queued).toBeTrue();
    const firstRevision: number = unacknowledgedTemporaryAdBypassWrites.get(7)!.revision;
    expect(recordTemporaryAdBypassActivity(7, now)?.queued).toBeTrue();
    const secondRevision: number = unacknowledgedTemporaryAdBypassWrites.get(7)!.revision;
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)?.activity?.sendCount).toBe(2);

    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        temporaryAdBypassWrites: [{ id: 7, revision: firstRevision }],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)?.revision).toBe(secondRevision);
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        temporaryAdBypassWrites: [{ id: 7, revision: secondRevision }],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedTemporaryAdBypassWrites.has(7)).toBeFalse();

    expect(clearTemporaryAdBypassActivity(7)).toBeTrue();
    expect(temporaryAdBypassActivityCache.peek(7)).toBeNull();
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)?.activity).toBeNull();
  });

  test("黑名单命中或黑名单视图冷缺失时发言不产出临时累计写", () => {
    const now: number = Date.now();
    seedMissing(7);
    expect(queueIdentityPolicyWrite("blocklist", 7, blockValue())).toBeTrue();
    expect(recordTemporaryAdBypassActivity(7, now)).toBeUndefined();

    // 三份 LRU 各自淘汰：临时累计仍热而黑名单视图已冷时不能按「不在名单」累计。
    whitelistEntryCache.set(8, null);
    temporaryAdBypassActivityCache.set(8, null);
    expect(recordTemporaryAdBypassActivity(8, now)).toBeUndefined();

    expect(temporaryAdBypassActivityCache.peek(7)).toBeNull();
    expect(temporaryAdBypassActivityCache.peek(8)).toBeNull();
    expect(unacknowledgedTemporaryAdBypassWrites.size).toBe(0);
    expect(diskMessages.some(
      (message: DiskBusinessMessage): boolean => message.type === "temporaryAdBypassWrite"
    )).toBeFalse();
  });

  test("当天达标后同日发言不再产生写回，跨日恢复推进", () => {
    const dayAt: number = new Date("2026-08-01T12:00:00+09:00").getTime();
    seedMissing(7);
    for (let index: number = 0; index < 8; index++) {
      expect(recordTemporaryAdBypassActivity(7, dayAt + index)?.queued).toBeTrue();
    }
    const qualified: Readonly<TemporaryAdBypassActivity> | null | undefined =
      temporaryAdBypassActivityCache.peek(7);
    if (qualified === null || qualified === undefined) {
      throw new Error("qualified activity must exist");
    }
    expect(qualified.qualifiedAt).toBe(dayAt + 7);
    const revision: number = unacknowledgedTemporaryAdBypassWrites.get(7)!.revision;
    const queuedWrites: number = diskMessages.length;

    for (let index: number = 8; index < 64; index++) {
      const recorded: RecordedTemporaryAdBypassActivity | undefined =
        recordTemporaryAdBypassActivity(7, dayAt + index);
      expect(recorded?.queued).toBeTrue();
      expect(recorded?.activity).toBe(qualified);
    }
    expect(diskMessages.length).toBe(queuedWrites);
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)?.revision).toBe(revision);
    expect(temporaryAdBypassActivityCache.peek(7)).toBe(qualified);

    // 跨东京日的第一条发言仍然重置当日累计并落盘。
    const nextDayAt: number = dayAt + DAY_MS;
    expect(recordTemporaryAdBypassActivity(7, nextDayAt)?.activity).toMatchObject({
      adBypass: true,
      qualifiedDays: 1,
      sendCount: 1,
      countedAt: nextDayAt,
      qualifiedAt: null,
    });
    expect(diskMessages.length).toBe(queuedWrites + 1);
    for (let index: number = 1; index < 8; index++) {
      expect(recordTemporaryAdBypassActivity(7, nextDayAt + index)?.queued).toBeTrue();
    }
    expect(temporaryAdBypassActivityCache.peek(7)).toMatchObject({
      qualifiedDays: 2,
      sendCount: 8,
      qualifiedAt: nextDayAt + 7,
    });
    expect(diskMessages.length).toBe(queuedWrites + 8);
  });

  test("广告 true 清理在冷读失败窗口仍发布可重放墓碑", () => {
    expect(temporaryAdBypassActivityCache.has(7)).toBeFalse();

    expect(clearTemporaryAdBypassActivity(7)).toBeTrue();

    expect(temporaryAdBypassActivityCache.peek(7)).toBeNull();
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)).toEqual({
      activity: null,
      revision: 1,
    });
    expect(diskMessages.at(-1)).toEqual({
      type: "temporaryAdBypassWrite",
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
    pendingRead.resolve({ whitelist: [], blocklist: [], temporaryAdBypass: [] });
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
        temporaryAdBypassWrites: [],
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
    const bytes: number = 256 + unacknowledgedBlocklistWrites.get(7)!.data!.length * 2;
    expect(unacknowledgedIdentityBytes.current.blocklist).toBe(bytes);

    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [{ table: "blocklist", id: 7, revision: firstRevision }],
        temporaryAdBypassWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedBlocklistWrites.get(7)?.revision).toBe(secondRevision);
    expect(unacknowledgedIdentityBytes.current.blocklist).toBe(bytes);
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [{ table: "blocklist", id: 7, revision: secondRevision }],
        temporaryAdBypassWrites: [],
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedBlocklistWrites.has(7)).toBeFalse();
    expect(unacknowledgedIdentityBytes.current.blocklist).toBe(0);
  });

  test("未确认身份字节只保留最终值，删除墓碑仍记费，重置同时清除额度", () => {
    seedMissing(7);
    seedMissing(8);
    queueIdentityPolicyWrite("blocklist", 7, blockValue());
    queueIdentityPolicyWrite("blocklist", 8, blockValue());
    const otherBytes: number = 256 + unacknowledgedBlocklistWrites.get(8)!.data!.length * 2;
    queueIdentityPolicyWrite("blocklist", 7, null);
    expect(unacknowledgedIdentityBytes.current.blocklist).toBe(otherBytes + 256);
    expect(unacknowledgedIdentityBytes.current.whitelist).toBe(0);
    const revision: number = unacknowledgedBlocklistWrites.get(7)!.revision;
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [{ table: "blocklist", id: 7, revision }],
        temporaryAdBypassWrites: [], chatStateWrites: [], chatQaWrites: [],
      });
    }
    expect(unacknowledgedIdentityBytes.current.blocklist).toBe(otherBytes);
    resetIdentityStorageCache();
    expect(unacknowledgedIdentityBytes.current).toEqual({ whitelist: 0, blocklist: 0 });
    expect(unacknowledgedBlocklistWrites.size).toBe(0);
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

  test("Worker 重建把已经失效的临时广告免检重放归一化为墓碑", async () => {
    const staleAt: number = Date.now() - 2 * DAY_MS;
    seedMissing(7);
    for (let index: number = 0; index < 8; index++) {
      expect(recordTemporaryAdBypassActivity(7, staleAt + index)?.queued).toBeTrue();
    }
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)?.activity?.adBypass)
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
      type: "temporaryAdBypassWrite",
      id: 7,
      activity: null,
    })]);
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)?.activity).toBeNull();
    expect(temporaryAdBypassActivityCache.peek(7)).toBeNull();
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
      temporaryAdBypassActivityCache.set(id, null);
    }
    expect(blocklistEntryCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);
    expect(whitelistEntryCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);
    expect(temporaryAdBypassActivityCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);
    expect(blocklistEntryCache.has(1)).toBeFalse();
    expect(whitelistEntryCache.has(1)).toBeFalse();
    expect(temporaryAdBypassActivityCache.has(1)).toBeFalse();
  });

  test("长时间取键流转下临时广告免检只保留有界现场，Worker 重建按 revision 重放", async () => {
    const dayAt: number = new Date("2026-08-01T12:00:00+09:00").getTime();
    const churn: number = IDENTITY_READ_CACHE_MAX_ENTRIES * 2;

    // 消费者持续提交，主线程仅保留最新批次的未 ACK 最终值。
    let queued: number = 0;
    for (let id: number = 1; id <= churn; id++) {
      seedMissing(id);
      if (recordTemporaryAdBypassActivity(id, dayAt)?.queued === true) queued++;
      if (id % 128 === 0) {
        const writes: { id: number; revision: number }[] = [];
        for (const [key, write] of unacknowledgedTemporaryAdBypassWrites) writes.push({ id: key, revision: write.revision });
        for (const listener of persistedListeners) listener({ type: "identityStoragePersisted", writes: [], temporaryAdBypassWrites: writes, chatStateWrites: [], chatQaWrites: [] });
      }
    }
    expect(queued).toBe(churn);
    expect(temporaryAdBypassActivityCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);
    expect(temporaryAdBypassActivityCache.has(1)).toBeFalse();
    expect(unacknowledgedTemporaryAdBypassWrites.size).toBe(0);

    const settled: { id: number; revision: number }[] = [];
    for (const [id, write] of unacknowledgedTemporaryAdBypassWrites) {
      settled.push({ id, revision: write.revision });
    }
    for (const listener of persistedListeners) {
      listener({
        type: "identityStoragePersisted",
        writes: [],
        temporaryAdBypassWrites: settled,
        chatStateWrites: [],
        chatQaWrites: [],
      });
    }
    expect(unacknowledgedTemporaryAdBypassWrites.size).toBe(0);
    expect(temporaryAdBypassActivityCache.size).toBe(IDENTITY_READ_CACHE_MAX_ENTRIES);

    // 达标稳态不再产生任何未 ACK 现场：连续发言只走热度刷新。
    const steady: number = churn;
    for (let index: number = 1; index < 8; index++) {
      recordTemporaryAdBypassActivity(steady, dayAt + index);
    }
    const qualifiedRevision: number =
      unacknowledgedTemporaryAdBypassWrites.get(steady)!.revision;
    let frozen: number = 0;
    for (let index: number = 8; index < 512; index++) {
      if (recordTemporaryAdBypassActivity(steady, dayAt + index)?.queued === true) frozen++;
    }
    expect(frozen).toBe(504);
    expect(unacknowledgedTemporaryAdBypassWrites.size).toBe(1);
    expect(unacknowledgedTemporaryAdBypassWrites.get(steady)?.revision)
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
      type: "temporaryAdBypassWrite",
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
      temporaryAdBypass: [],
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

  test("多块预热时后一块冷读失败返回 false，前一块已写入的结论保留，重试只读剩余冷键", async () => {
    const now: number = Date.now();
    const lastWarmId: number = IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES;
    const coldId: number = IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 1;
    const ids: number[] = [];
    for (let id: number = 1; id <= coldId; id++) ids.push(id);
    readImplementation = async (
      requested: readonly number[]
    ): Promise<IdentityPolicyRawReadResult> => {
      if (requested.includes(coldId)) {
        throw new Error("Persistence Worker is unavailable; cannot read identity policies.");
      }
      return {
        whitelist: [[1, JSON.stringify({
          permissions: DEFAULT_WHITELIST_PERMISSIONS,
          meta: { firstName: "Alice", lastName: "", username: "alice" },
        })]],
        blocklist: [[2, JSON.stringify(blockValue())]],
        temporaryAdBypass: [{
          id: 3,
          adBypass: true,
          adBypassGrantedAt: now - DAY_MS,
          qualifiedDays: 7,
          sendCount: 8,
          countedAt: now - DAY_MS,
          qualifiedAt: now - DAY_MS,
        }],
      };
    };

    await expect(prefetchIdentityPolicies(ids)).resolves.toBeFalse();
    expect(readIdentityPolicies).toHaveBeenCalledTimes(2);
    expect(readIdentityPolicies.mock.calls[0]![0]).toHaveLength(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
    expect(readIdentityPolicies.mock.calls[1]![0]).toEqual([coldId]);
    // 第一块读回后已逐键写入三份 LRU；第二块失败只让自己的主键保持冷缺失。
    expect(cachedWhitelistEntry(1)?.meta.username).toBe("alice");
    expect(cachedBlocklistEntry(1)).toBeUndefined();
    expect(cachedBlocklistEntry(2)?.meta.username).toBe("alice");
    expect(temporaryAdBypassActivityCache.peek(3)).toMatchObject({
      adBypass: true,
      qualifiedDays: 7,
    });
    expect(isIdentityPolicyCached(lastWarmId)).toBeTrue();
    expect(whitelistEntryCache.peek(lastWarmId)).toBeNull();
    expect(blocklistEntryCache.peek(lastWarmId)).toBeNull();
    expect(temporaryAdBypassActivityCache.peek(lastWarmId)).toBeNull();
    expect(whitelistEntryCache.has(coldId)).toBeFalse();
    expect(blocklistEntryCache.has(coldId)).toBeFalse();
    expect(temporaryAdBypassActivityCache.has(coldId)).toBeFalse();

    readImplementation = async (): Promise<IdentityPolicyRawReadResult> => ({
      whitelist: [],
      blocklist: [],
      temporaryAdBypass: [],
    });
    await expect(prefetchIdentityPolicies(ids)).resolves.toBeTrue();
    expect(readIdentityPolicies).toHaveBeenCalledTimes(3);
    expect(readIdentityPolicies.mock.calls[2]![0]).toEqual([coldId]);
    expect(isIdentityPolicyCached(coldId)).toBeTrue();
    expect(cachedWhitelistEntry(1)?.meta.username).toBe("alice");
  });
});

describe("启动计数灌入", () => {
  test("合法计数清空三份主线程 LRU 后写入两表计数，黑名单计数决定是否存在拉黑身份", () => {
    seedMissing(7);
    blocklistEntryCache.set(8, blockValue());
    whitelistEntryCache.set(8, null);
    temporaryAdBypassActivityCache.set(8, null);

    hydrateIdentityStorageCounts(2, 1);

    expect(whitelistEntryCache.size).toBe(0);
    expect(blocklistEntryCache.size).toBe(0);
    expect(temporaryAdBypassActivityCache.size).toBe(0);
    expect(isIdentityPolicyCached(7)).toBeFalse();
    expect(cachedBlocklistEntry(8)).toBeUndefined();
    expect(identityEntryCounts).toEqual({ whitelist: 2, blocklist: 1 });
    expect(hasAnyBlockedIdentity()).toBeTrue();

    // write-through 以灌入的计数为基线增减。
    seedMissing(9);
    expect(queueIdentityPolicyWrite("whitelist", 9, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toBeTrue();
    expect(identityEntryCounts.whitelist).toBe(3);

    hydrateIdentityStorageCounts(0, 0);
    expect(whitelistEntryCache.has(9)).toBeFalse();
    expect(identityEntryCounts).toEqual({ whitelist: 0, blocklist: 0 });
    expect(hasAnyBlockedIdentity()).toBeFalse();

    hydrateIdentityStorageCounts(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(identityEntryCounts).toEqual({
      whitelist: Number.MAX_SAFE_INTEGER,
      blocklist: Number.MAX_SAFE_INTEGER,
    });
  });

  test("灌入计数只清读取 LRU，三类未 ACK 最终值与 revision 保留并在再次预读时覆盖读回值", async () => {
    const now: number = Date.now();
    seedMissing(7);
    expect(queueIdentityPolicyWrite("whitelist", 7, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toBeTrue();
    seedMissing(8);
    expect(queueIdentityPolicyWrite("blocklist", 8, blockValue())).toBeTrue();
    seedMissing(9);
    expect(recordTemporaryAdBypassActivity(9, now)?.queued).toBeTrue();
    const whitelistRevision: number = unacknowledgedWhitelistWrites.get(7)!.revision;
    const blocklistRevision: number = unacknowledgedBlocklistWrites.get(8)!.revision;
    const temporaryRevision: number = unacknowledgedTemporaryAdBypassWrites.get(9)!.revision;
    const pendingBytes: Record<string, number> = { ...unacknowledgedIdentityBytes.current };

    hydrateIdentityStorageCounts(1, 1);

    expect(whitelistEntryCache.size).toBe(0);
    expect(blocklistEntryCache.size).toBe(0);
    expect(temporaryAdBypassActivityCache.size).toBe(0);
    expect(unacknowledgedWhitelistWrites.get(7)?.revision).toBe(whitelistRevision);
    expect(unacknowledgedBlocklistWrites.get(8)?.revision).toBe(blocklistRevision);
    expect(unacknowledgedTemporaryAdBypassWrites.get(9)?.revision).toBe(temporaryRevision);
    expect(unacknowledgedIdentityBytes.current).toEqual(pendingBytes);

    // 数据库读回的仍是落盘前的空结果；未 ACK 最终值必须盖过它。
    await expect(prefetchIdentityPolicies([7, 8, 9])).resolves.toBeTrue();
    expect(cachedWhitelistEntry(7)?.meta.username).toBe("alice");
    expect(cachedBlocklistEntry(8)?.meta.username).toBe("alice");
    expect(temporaryAdBypassActivityCache.peek(9)?.sendCount).toBe(1);

    // revision 发号器没有回退：下一次写入的 revision 严格大于灌入前的那次。
    expect(recordTemporaryAdBypassActivity(9, now)?.queued).toBeTrue();
    expect(unacknowledgedTemporaryAdBypassWrites.get(9)!.revision).toBeGreaterThan(temporaryRevision);
  });

  const invalidCounts: readonly (readonly [string, number])[] = [
    ["负数", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["小数", 1.5],
    ["超过安全整数范围", Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [label, invalid] of invalidCounts) {
    test(`计数为${label}时在清空缓存前拒绝，既有 LRU 与计数原样保留`, () => {
      seedMissing(7);
      blocklistEntryCache.set(8, blockValue());
      whitelistEntryCache.set(8, null);
      temporaryAdBypassActivityCache.set(8, null);
      identityEntryCounts.whitelist = 4;
      identityEntryCounts.blocklist = 5;

      expect(() => hydrateIdentityStorageCounts(invalid, 1))
        .toThrow("Whitelist entry count must be a non-negative safe integer.");
      // 白名单计数合法时也不能先写入它再因黑名单计数失败留下半份状态。
      expect(() => hydrateIdentityStorageCounts(1, invalid))
        .toThrow("Blocklist entry count must be a non-negative safe integer.");

      expect(identityEntryCounts).toEqual({ whitelist: 4, blocklist: 5 });
      expect(whitelistEntryCache.size).toBe(2);
      expect(blocklistEntryCache.size).toBe(2);
      expect(temporaryAdBypassActivityCache.size).toBe(2);
      expect(isIdentityPolicyCached(7)).toBeTrue();
      expect(cachedBlocklistEntry(8)?.meta.username).toBe("alice");
    });
  }
});

describe("补扫游标页 fail-closed 校验", () => {
  /** 伪造一份 Disk I/O 游标页回包，断言主线程拒收且不留下任何据此产生的状态。 */
  async function expectRejectedPage(
    afterId: number | null,
    page: BlocklistIdPage,
    message: string
  ): Promise<void> {
    readBlocklistIdPage.mockClear();
    pageReadImplementation = async (): Promise<BlocklistIdPage> => page;

    await expect(readBlocklistSweepPage(afterId)).rejects.toThrow(message);

    expect(flushDiskIODomainOutcome).toHaveBeenCalledWith("blocklist");
    expect(readBlocklistIdPage).toHaveBeenCalledTimes(1);
    expect(readBlocklistIdPage).toHaveBeenCalledWith(afterId);
    expect(diskMessages).toEqual([]);
    expect(identityEntryCounts).toEqual({ whitelist: 0, blocklist: 0 });
    expect(blocklistEntryCache.size).toBe(0);
    expect(whitelistEntryCache.size).toBe(0);
  }

  test("超过固定页大小的回包被拒收，即使升序与游标都自洽", async () => {
    const ids: number[] = [];
    for (let id: number = 1; id <= BLOCKLIST_SWEEP_PAGE_SIZE + 1; id++) ids.push(id);
    await expectRejectedPage(
      null,
      { ids, nextCursor: BLOCKLIST_SWEEP_PAGE_SIZE + 1, done: true },
      `Blocklist ID page exceeds ${BLOCKLIST_SWEEP_PAGE_SIZE} entries.`
    );
  });

  test("页内出现 0 或非安全整数主键时按非法身份拒收", async () => {
    await expectRejectedPage(
      null,
      { ids: [0], nextCursor: 0, done: true },
      "blocklist ID page: $.id must be a non-zero safe integer Telegram identity ID."
    );
    const unsafeId: number = Number.MAX_SAFE_INTEGER + 1;
    await expectRejectedPage(
      null,
      { ids: [unsafeId], nextCursor: unsafeId, done: true },
      "blocklist ID page: $.id must be a non-zero safe integer Telegram identity ID."
    );
  });

  test("主键不严格晚于游标或页内不严格升序时拒收", async () => {
    await expectRejectedPage(
      7,
      { ids: [7], nextCursor: 7, done: true },
      "Blocklist ID page must be strictly ordered after its cursor."
    );
    await expectRejectedPage(
      null,
      { ids: [9, 9], nextCursor: 9, done: true },
      "Blocklist ID page must be strictly ordered after its cursor."
    );
  });

  test("续读游标不是本页末尾主键、或空页挪动了请求游标时拒收", async () => {
    await expectRejectedPage(
      7,
      { ids: [8, 9], nextCursor: 8, done: true },
      "Blocklist ID page returned an inconsistent next cursor."
    );
    await expectRejectedPage(
      7,
      { ids: [], nextCursor: null, done: true },
      "Blocklist ID page returned an inconsistent next cursor."
    );
  });

  test("非最后一页未填满固定页大小时拒收，空的非最后一页同样拒收", async () => {
    await expectRejectedPage(
      null,
      { ids: [8, 9], nextCursor: 9, done: false },
      "A non-final blocklist ID page must fill the fixed page size."
    );
    await expectRejectedPage(
      7,
      { ids: [], nextCursor: 7, done: false },
      "A non-final blocklist ID page must fill the fixed page size."
    );
  });
});
