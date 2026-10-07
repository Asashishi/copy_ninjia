/**
 * 主线程临时广告免检累计：冷读填充正缓存、按主键保留最新 revision 的精确 ACK 收敛、
 * 与黑名单互斥、当天达标后的稳态冻结与跨日推进、墓碑发布、revision 耗尽与投递被拒，
 * 以及 Disk I/O Worker 重建时的失效归一化与长时间取键流转下的有界现场。
 *
 * Disk I/O 替身与逐用例复位见 test/helpers/identityStorageHarness.ts。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  acceptDiskMessages,
  blockValue,
  diskMessages,
  persistedListeners,
  readIdentityPolicies,
  readImplementation,
  resetIdentityStorageHarness,
  recordingTransport,
  respawnListeners,
} from "../helpers/identityStorageHarness";
import { seedMissingIdentity as seedMissing } from "../helpers/identityStorage";
import {
  IDENTITY_READ_CACHE_MAX_ENTRIES,
  IDENTITY_WRITE_BATCH_MAX_ENTRIES,
} from "../../packages/consts/identityStorage";
import { DAY_MS } from "../../packages/consts/time";
import {
  TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
} from "../../packages/consts/temporaryAdBypass";
import type {
  DiskBusinessMessage,
  DiskIORecoveryTransport,
} from "../../packages/types/diskIO";
import type { IdentityPolicyRawReadResult } from "../../packages/types/identityStorage";
import type { TemporaryAdBypassActivity } from "../../packages/types/states/temporaryAdBypass";

const {
  whitelistEntryCache,
} = await import("../../packages/cache/main/identityStorage");
const {
  temporaryAdBypassActivityCache,
  temporaryAdBypassWriteRevision,
  unacknowledgedTemporaryAdBypassWrites,
} = await import(
  "../../packages/cache/main/temporaryAdBypass"
);
const {
  clearTemporaryAdBypassActivity,
  hasActiveTemporaryAdBypassAt,
  recordTemporaryAdBypassActivity,
} = await import("../../packages/infra/identityPolicy/temporaryAdBypass");
const {
  prefetchIdentityPolicies,
  queueIdentityPolicyWrite,
} = await import("../../packages/infra/identityStorage");

/** 一个东京日内让当天成为合格日所需的发言条数。 */
const QUALIFYING_DAILY_MESSAGES: number = TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD + 1;

beforeEach(resetIdentityStorageHarness);

describe("主线程身份 LRU 与数据库最终一致性", () => {
  test("冷读填充上一东京日已达标的临时广告免检正缓存", async () => {
    const now: number = Date.now();
    readImplementation.current = async (): Promise<IdentityPolicyRawReadResult> => ({
      whitelist: [],
      blocklist: [],
      temporaryAdBypass: [{
        id: 7,
        adBypass: true,
        adBypassGrantedAt: now - DAY_MS,
        qualifiedDays: TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
        sendCount: QUALIFYING_DAILY_MESSAGES,
        countedAt: now - DAY_MS,
        qualifiedAt: now - DAY_MS,
      }],
    });

    await expect(prefetchIdentityPolicies([7])).resolves.toBeTrue();
    expect(hasActiveTemporaryAdBypassAt(7, Date.now())).toBeTrue();
    await expect(prefetchIdentityPolicies([7])).resolves.toBeTrue();
    expect(readIdentityPolicies).toHaveBeenCalledTimes(1);
  });

  test("临时广告免检发言写入按主键保留最新 revision 并由精确 ACK 收敛", () => {
    const now: number = Date.now();
    seedMissing(7);
    expect(recordTemporaryAdBypassActivity(7, now)).toBeDefined();
    const firstRevision: number = unacknowledgedTemporaryAdBypassWrites.get(7)!.revision;
    expect(recordTemporaryAdBypassActivity(7, now)).toBeDefined();
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

    // 三份 LRU 各自淘汰：临时累计仍热而黑名单视图已冷时，不按「不在名单」累计。
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
    for (let index: number = 0; index < QUALIFYING_DAILY_MESSAGES; index++) {
      expect(recordTemporaryAdBypassActivity(7, dayAt + index)).toBeDefined();
    }
    const qualified: Readonly<TemporaryAdBypassActivity> | null | undefined =
      temporaryAdBypassActivityCache.peek(7);
    if (qualified === null || qualified === undefined) {
      throw new Error("qualified activity must exist");
    }
    expect(qualified.qualifiedAt).toBe(dayAt + QUALIFYING_DAILY_MESSAGES - 1);
    const revision: number = unacknowledgedTemporaryAdBypassWrites.get(7)!.revision;
    const queuedWrites: number = diskMessages.length;

    for (let index: number = QUALIFYING_DAILY_MESSAGES; index < 64; index++) {
      const recorded: Readonly<TemporaryAdBypassActivity> | undefined =
        recordTemporaryAdBypassActivity(7, dayAt + index);
      expect(recorded).toBe(qualified);
    }
    expect(diskMessages.length).toBe(queuedWrites);
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)?.revision).toBe(revision);
    expect(temporaryAdBypassActivityCache.peek(7)).toBe(qualified);

    // 跨东京日的第一条发言仍然重置当日累计并落盘。
    const nextDayAt: number = dayAt + DAY_MS;
    expect(recordTemporaryAdBypassActivity(7, nextDayAt)).toMatchObject({
      adBypass: true,
      qualifiedDays: 1,
      sendCount: 1,
      countedAt: nextDayAt,
      qualifiedAt: null,
    });
    expect(diskMessages.length).toBe(queuedWrites + 1);
    for (let index: number = 1; index < QUALIFYING_DAILY_MESSAGES; index++) {
      expect(recordTemporaryAdBypassActivity(7, nextDayAt + index)).toBeDefined();
    }
    expect(temporaryAdBypassActivityCache.peek(7)).toMatchObject({
      qualifiedDays: 2,
      sendCount: QUALIFYING_DAILY_MESSAGES,
      qualifiedAt: nextDayAt + QUALIFYING_DAILY_MESSAGES - 1,
    });
    expect(diskMessages.length).toBe(queuedWrites + QUALIFYING_DAILY_MESSAGES);
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

  test("临时广告免检写入：revision 耗尽在发布前失败；投递被拒时保留最终值等待重建重放", () => {
    const now: number = Date.now();
    seedMissing(7);
    temporaryAdBypassWriteRevision.current = Number.MAX_SAFE_INTEGER;

    expect(() => recordTemporaryAdBypassActivity(7, now)).toThrow("revision space is exhausted");
    expect(temporaryAdBypassActivityCache.peek(7)).toBeNull();
    expect(unacknowledgedTemporaryAdBypassWrites.has(7)).toBeFalse();
    expect(diskMessages).toEqual([]);

    temporaryAdBypassWriteRevision.current = 0;
    acceptDiskMessages.current = false;
    const recorded: ReturnType<typeof recordTemporaryAdBypassActivity> =
      recordTemporaryAdBypassActivity(7, now);

    expect(recorded).toBeDefined();
    expect(temporaryAdBypassActivityCache.peek(7)).toBe(recorded);
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)).toEqual({
      activity: recorded!,
      revision: 1,
    });
    expect(diskMessages).toEqual([{
      type: "temporaryAdBypassWrite",
      id: 7,
      activity: recorded!,
      revision: 1,
    }]);
  });

  test("Worker 重建把已经失效的临时广告免检重放归一化为墓碑", async () => {
    const staleAt: number = Date.now() - 2 * DAY_MS;
    seedMissing(7);
    for (let index: number = 0; index < QUALIFYING_DAILY_MESSAGES; index++) {
      expect(recordTemporaryAdBypassActivity(7, staleAt + index)).toBeDefined();
    }
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)?.activity?.adBypass)
      .toBeTrue();

    const replayed: DiskBusinessMessage[] = [];
    const transport: DiskIORecoveryTransport = recordingTransport(replayed);

    for (const listener of respawnListeners) expect(await listener(transport)).toBeTrue();
    expect(replayed).toEqual([expect.objectContaining({
      type: "temporaryAdBypassWrite",
      id: 7,
      activity: null,
    })]);
    expect(unacknowledgedTemporaryAdBypassWrites.get(7)?.activity).toBeNull();
    expect(temporaryAdBypassActivityCache.peek(7)).toBeNull();
  });

  test("长时间取键流转下临时广告免检只保留有界现场，Worker 重建按 revision 重放", async () => {
    const dayAt: number = new Date("2026-08-01T12:00:00+09:00").getTime();
    const churn: number = IDENTITY_READ_CACHE_MAX_ENTRIES * 2;

    // 消费者持续提交，主线程仅保留最新批次的未 ACK 最终值。
    let queued: number = 0;
    for (let id: number = 1; id <= churn; id++) {
      seedMissing(id);
      if (recordTemporaryAdBypassActivity(id, dayAt) !== undefined) queued++;
      if (id % IDENTITY_WRITE_BATCH_MAX_ENTRIES === 0) {
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
    const steadyMessages: number = 512;
    for (let index: number = 1; index < QUALIFYING_DAILY_MESSAGES; index++) {
      recordTemporaryAdBypassActivity(steady, dayAt + index);
    }
    const qualifiedRevision: number =
      unacknowledgedTemporaryAdBypassWrites.get(steady)!.revision;
    let frozen: number = 0;
    for (let index: number = QUALIFYING_DAILY_MESSAGES; index < steadyMessages; index++) {
      if (recordTemporaryAdBypassActivity(steady, dayAt + index) !== undefined) frozen++;
    }
    expect(frozen).toBe(steadyMessages - QUALIFYING_DAILY_MESSAGES);
    expect(unacknowledgedTemporaryAdBypassWrites.size).toBe(1);
    expect(unacknowledgedTemporaryAdBypassWrites.get(steady)?.revision)
      .toBe(qualifiedRevision);

    const replayed: DiskBusinessMessage[] = [];
    const transport: DiskIORecoveryTransport = recordingTransport(replayed);
    for (const listener of respawnListeners) expect(await listener(transport)).toBeTrue();
    expect(replayed).toEqual([expect.objectContaining({
      type: "temporaryAdBypassWrite",
      id: steady,
      revision: qualifiedRevision,
    })]);
  });
});
