/**
 * 主线程身份存储的 LRU 与数据库最终一致性：write-through、精确 ACK 收敛、未确认字节
 * 记账、revision 耗尽、Disk I/O Worker 重建重放、预取分块与冷读失败降级，以及启动计数灌入。
 *
 * Disk I/O 替身与逐用例复位见 test/helpers/identityStorageHarness.ts；临时广告免检见
 * identityStorageTemporaryAdBypass.test.ts，黑名单补扫游标页见 identityStorageSweep.test.ts。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  acceptDiskMessages,
  blockValue,
  diskMessages,
  flushDiskIODomain,
  persistedListeners,
  readIdentityPolicies,
  readImplementation,
  resetIdentityStorageHarness,
  recordingTransport,
  respawnListeners,
} from "../helpers/identityStorageHarness";
import { seedMissingIdentity as seedMissing } from "../helpers/identityStorage";
import {
  IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES,
  IDENTITY_READ_CACHE_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import { DISK_BUSINESS_MESSAGE_BASE_BYTES } from "../../packages/consts/diskIO/business";
import { DAY_MS } from "../../packages/consts/time";
import {
  TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
} from "../../packages/consts/temporaryAdBypass";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import type {
  DiskBusinessMessage,
  DomainFlushOutcome,
  DiskIORecoveryTransport,
} from "../../packages/types/diskIO";
import type { IdentityPolicyRawReadResult } from "../../packages/types/identityStorage";

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
const { recordTemporaryAdBypassActivity } =
  await import("../../packages/infra/identityPolicy/temporaryAdBypass");
const {
  cachedBlocklistEntry,
  cachedWhitelistEntry,
  confirmIdentityPolicyPersisted,
  hasAnyBlockedIdentity,
  hydrateIdentityStorageCounts,
  isIdentityPolicyCached,
  prefetchIdentityPolicies,
  queueIdentityPolicyWrite,
} = await import("../../packages/infra/identityStorage");

/** 一个东京日内让当天成为合格日所需的发言条数。 */
const QUALIFYING_DAILY_MESSAGES: number = TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD + 1;

beforeEach(resetIdentityStorageHarness);

describe("主线程身份 LRU 与数据库最终一致性", () => {
  test("未 ACK 最终值覆盖迟到数据库冷读，不能把新拉黑回滚成负缓存", async () => {
    const pendingRead: PromiseWithResolvers<IdentityPolicyRawReadResult> =
      Promise.withResolvers<IdentityPolicyRawReadResult>();
    readImplementation.current = async (): Promise<IdentityPolicyRawReadResult> => pendingRead.promise;
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
    const bytes: number = DISK_BUSINESS_MESSAGE_BASE_BYTES + unacknowledgedBlocklistWrites.get(7)!.data!.length * 2;
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
    const otherBytes: number = DISK_BUSINESS_MESSAGE_BASE_BYTES + unacknowledgedBlocklistWrites.get(8)!.data!.length * 2;
    queueIdentityPolicyWrite("blocklist", 7, null);
    expect(unacknowledgedIdentityBytes.current.blocklist).toBe(otherBytes + DISK_BUSINESS_MESSAGE_BASE_BYTES);
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
    acceptDiskMessages.current = false;
    expect(queueIdentityPolicyWrite("whitelist", 7, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toBeFalse();
    expect(diskMessages).toHaveLength(1);

    acceptDiskMessages.current = true;
    await expect(confirmIdentityPolicyPersisted("whitelist", 7, true))
      .resolves.toBeUndefined();

    expect(diskMessages).toHaveLength(2);
    expect(flushDiskIODomain).toHaveBeenCalledWith("whitelist");
    expect(unacknowledgedWhitelistWrites.has(7)).toBeFalse();
  });

  test("领域 flush 声称成功但缺少目标精确 ACK 时仍拒绝收敛缓存", async () => {
    seedMissing(7);
    expect(queueIdentityPolicyWrite("whitelist", 7, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toBeTrue();
    flushDiskIODomain.mockImplementationOnce(
      async (): Promise<DomainFlushOutcome> => ({ result: "flushed" })
    );

    await expect(confirmIdentityPolicyPersisted("whitelist", 7, false))
      .rejects.toThrow("did not acknowledge");
    expect(diskMessages).toHaveLength(1);
    expect(unacknowledgedWhitelistWrites.has(7)).toBeTrue();
  });

  test("领域 flush 失败时报错逐字点名结局、revision 与失败领域；无回执时如实说明", async () => {
    seedMissing(7);
    expect(queueIdentityPolicyWrite("whitelist", 7, {
      permissions: DEFAULT_WHITELIST_PERMISSIONS,
      meta: { firstName: "Alice", lastName: "", username: "alice" },
    })).toBeTrue();
    const revision: number = unacknowledgedWhitelistWrites.get(7)!.revision;
    flushDiskIODomain.mockImplementationOnce(
      async (): Promise<DomainFlushOutcome> => ({ result: "failed", failedDomains: ["whitelist", "luck"] })
    );
    await expect(confirmIdentityPolicyPersisted("whitelist", 7, false)).rejects.toThrow(
      `Persistence flush failed for whitelist identity 7 revision ${revision}; failed domains: whitelist, luck.`
    );
    flushDiskIODomain.mockImplementationOnce(
      async (): Promise<DomainFlushOutcome> => ({ result: "timedOut" })
    );
    await expect(confirmIdentityPolicyPersisted("whitelist", 7, false)).rejects.toThrow(
      `Persistence flush timedOut for whitelist identity 7 revision ${revision}; no per-domain reply.`
    );
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
    const transport: DiskIORecoveryTransport = recordingTransport(replayed);

    for (const listener of respawnListeners) expect(await listener(transport)).toBeTrue();
    expect(replayed).toEqual([expect.objectContaining({
      type: "identityPolicyWrite",
      table: "blocklist",
      id: 7,
      revision: unacknowledgedBlocklistWrites.get(7)!.revision,
    })]);
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
    const transport: DiskIORecoveryTransport = recordingTransport(replayed);

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

  test("一次更新的超大身份集合按预取分块上限分成有界数据库读", async () => {
    const ids: number[] = [];
    for (let id: number = 1; id <= IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES + 1; id++) ids.push(id);
    await expect(prefetchIdentityPolicies(ids)).resolves.toBeTrue();
    expect(readIdentityPolicies).toHaveBeenCalledTimes(2);
    expect(readIdentityPolicies.mock.calls[0]![0]).toHaveLength(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES);
    expect(readIdentityPolicies.mock.calls[1]![0]).toHaveLength(1);
  });

  test("分块步长严格小于 LRU 容量，同一次预取的前一块不会被后一块整块驱逐", () => {
    expect(IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES)
      .toBeLessThan(IDENTITY_READ_CACHE_MAX_ENTRIES);
  });

  test("冷读失败就地降级为「仍是冷的」，不把异常抛给 update 前置中间件", async () => {
    readImplementation.current = async (): Promise<IdentityPolicyRawReadResult> => {
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
    readImplementation.current = async (
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
          qualifiedDays: TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
          sendCount: QUALIFYING_DAILY_MESSAGES,
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
      qualifiedDays: TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
    });
    expect(isIdentityPolicyCached(lastWarmId)).toBeTrue();
    expect(whitelistEntryCache.peek(lastWarmId)).toBeNull();
    expect(blocklistEntryCache.peek(lastWarmId)).toBeNull();
    expect(temporaryAdBypassActivityCache.peek(lastWarmId)).toBeNull();
    expect(whitelistEntryCache.has(coldId)).toBeFalse();
    expect(blocklistEntryCache.has(coldId)).toBeFalse();
    expect(temporaryAdBypassActivityCache.has(coldId)).toBeFalse();

    readImplementation.current = async (): Promise<IdentityPolicyRawReadResult> => ({
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
    expect(recordTemporaryAdBypassActivity(9, now)).toBeDefined();
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
    expect(recordTemporaryAdBypassActivity(9, now)).toBeDefined();
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
      // 白名单计数合法时，黑名单计数失败也不留下半份状态。
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
