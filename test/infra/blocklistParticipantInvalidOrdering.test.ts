import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BLOCKED_AT,
  META,
  deferred,
  identityWrites,
  lastWrittenData,
  participantInvalidDiskIO,
  participantInvalidHarness,
  participantInvalidLogger,
  readIdentityPolicies,
  receipt,
  resetParticipantInvalidHarness,
  storeBlocked,
  writtenCounts,
} from "../helpers/blocklistParticipantInvalidHarness";
import { waitUntil } from "../helpers/waitUntil";
import {
  BLOCKLIST_PARTICIPANT_INVALID_LIMIT,
  BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS,
} from "../../packages/consts/antiRaid/blocklist";
import type { BlocklistIdPage } from "../../packages/types/identityStorage";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";

/**
 * 黑名单销号计数的次序边界：回执到达顺序、逐身份队列里的解除核对、等待期间的
 * LRU 淘汰，以及补扫分页读的 flush 窗口。
 */

mock.module("../../packages/infra/diskIO", participantInvalidDiskIO);
mock.module("../../packages/infra/storage/stateStore", () => ({
  getChatStateCache: (): ReadonlyMap<number, { isInitEnabled: boolean; botPermissions: BotChatPermissions }> =>
    new Map([[-1001, { isInitEnabled: true, botPermissions: botPermissions() }]]),
}));
mock.module("../../packages/infra/logger", participantInvalidLogger);

const {
  blocklistIdentityMutationQueues,
  blocklistParticipantInvalidQueue,
  pendingBlockedRemovals,
} = await import("../../packages/cache/main/blocklist");
const {
  blocklistEntryCache,
  blocklistSweepFlushWindows,
  resetIdentityStorageCache,
  whitelistEntryCache,
} = await import("../../packages/cache/main/identityStorage");
const {
  cachedBlocklistEntry,
  prefetchIdentityPolicies,
  readBlocklistSweepPage,
} = await import("../../packages/infra/identityStorage");
const { runBlocklistIdentityMutation } = await import("../../packages/infra/identityPolicy/coordination");
const { isUserBlocked } = await import("../../packages/infra/blocklist/membership");
const { recordBlocklistParticipantReadability } = await import("../../packages/infra/blocklist/participantInvalid");

const EMPTY_PAGE: BlocklistIdPage = { ids: [], nextCursor: null, done: true };

async function drain(): Promise<void> {
  await blocklistParticipantInvalidQueue.current;
  await waitUntil((): boolean => blocklistIdentityMutationQueues.size === 0);
}

/** 打开一个补扫分页读的 flush 窗口，返回释放它的 resolver 与读取结果。 */
function openSweepWindow(): { release: () => void; page: Promise<BlocklistIdPage> } {
  const gate: { promise: Promise<void>; resolve: () => void } = deferred();
  participantInvalidHarness.flushGate = gate.promise;
  const page: Promise<BlocklistIdPage> = readBlocklistSweepPage(null);
  participantInvalidHarness.flushGate = null;
  return { release: gate.resolve, page };
}

beforeEach(async () => {
  await blocklistParticipantInvalidQueue.current;
  resetParticipantInvalidHarness();
  pendingBlockedRemovals.clear();
  resetIdentityStorageCache();
});

describe("黑名单销号计数的次序", () => {
  test("回执按到达顺序结算：先到的计数即使冷读更慢也排在后到的清零之前", async () => {
    storeBlocked(7, 2);
    const gate: { promise: Promise<void>; resolve: () => void } = deferred();
    participantInvalidHarness.readGate = gate.promise;

    recordBlocklistParticipantReadability(receipt([7]));
    recordBlocklistParticipantReadability(receipt([], [7]));
    await Bun.sleep(0);
    expect(identityWrites("blocklist")).toEqual([]);
    participantInvalidHarness.readGate = null;
    gate.resolve();
    await drain();

    expect(writtenCounts()).toEqual([[7, 3], [7, undefined]]);
  });

  test("排队期间清零后又涨回上限减 1，也按条目对象判定为已变化", async () => {
    storeBlocked(7, BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1);
    const busy: { promise: Promise<void>; resolve: () => void } = deferred();
    const held: Promise<void> = runBlocklistIdentityMutation(7, (): Promise<void> => busy.promise);

    recordBlocklistParticipantReadability(receipt([7]));
    recordBlocklistParticipantReadability(receipt([], [7]));
    for (let round: number = 1; round < BLOCKLIST_PARTICIPANT_INVALID_LIMIT; round++) {
      recordBlocklistParticipantReadability(receipt([7]));
    }
    await blocklistParticipantInvalidQueue.current;
    expect(cachedBlocklistEntry(7)?.participantInvalidCount).toBe(BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1);

    busy.resolve();
    await held;
    await drain();
    expect(isUserBlocked(7)).toBeTrue();
    expect(lastWrittenData(7)).toEqual({
      blockedAt: BLOCKED_AT,
      meta: META,
      participantInvalidCount: BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1,
    });
  });

  test("排队解除期间条目被淘汰后重读，放弃这次解除", async () => {
    storeBlocked(7, BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1);
    const busy: { promise: Promise<void>; resolve: () => void } = deferred();
    const held: Promise<void> = runBlocklistIdentityMutation(7, (): Promise<void> => busy.promise);

    recordBlocklistParticipantReadability(receipt([7]));
    await blocklistParticipantInvalidQueue.current;
    blocklistEntryCache.delete(7);
    busy.resolve();
    await held;
    await drain();

    expect(identityWrites("blocklist")).toEqual([]);
    expect(isUserBlocked(7)).toBeTrue();
  });

  test("等待窗口期间身份被淘汰时整条回执重新预热后一起写出", async () => {
    storeBlocked(7);
    storeBlocked(8);
    await prefetchIdentityPolicies([7, 8]);
    readIdentityPolicies.mockClear();
    const window: { release: () => void; page: Promise<BlocklistIdPage> } = openSweepWindow();

    recordBlocklistParticipantReadability(receipt([7, 8]));
    await Bun.sleep(0);
    expect(readIdentityPolicies).not.toHaveBeenCalled();
    whitelistEntryCache.delete(8);
    window.release();
    await expect(window.page).resolves.toEqual(EMPTY_PAGE);
    await drain();

    expect(readIdentityPolicies.mock.calls.map((call) => call[0])).toEqual([[8]]);
    expect(writtenCounts()).toEqual([[7, 1], [8, 1]]);
  });

  test("每轮都在写入前被淘汰时，轮数用尽后跳过整条回执并记错误", async () => {
    storeBlocked(7);
    storeBlocked(8);
    await prefetchIdentityPolicies([7, 8]);
    readIdentityPolicies.mockClear();
    let window: { release: () => void; page: Promise<BlocklistIdPage> } = openSweepWindow();
    recordBlocklistParticipantReadability(receipt([7, 8]));
    await Bun.sleep(0);

    for (let attempt: number = 1; attempt <= BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS; attempt++) {
      whitelistEntryCache.delete(8);
      const read: { promise: Promise<void>; resolve: () => void } = deferred();
      participantInvalidHarness.readGate = read.promise;
      window.release();
      await expect(window.page).resolves.toEqual(EMPTY_PAGE);
      if (attempt === BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS) break;
      // 下一轮预热卡在读库时再开一个窗口，让它预热完仍须等待。
      await waitUntil((): boolean => readIdentityPolicies.mock.calls.length === attempt);
      window = openSweepWindow();
      participantInvalidHarness.readGate = null;
      read.resolve();
      await Bun.sleep(0);
    }
    participantInvalidHarness.readGate = null;
    await drain();

    expect(identityWrites("blocklist")).toEqual([]);
    expect(readIdentityPolicies).toHaveBeenCalledTimes(BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS - 1);
    expect(participantInvalidHarness.loggedErrors.some((message: string): boolean =>
      message.includes("Skipped blocklist PARTICIPANT_ID_INVALID counts for removal 1 in chat -1001")
    )).toBeTrue();
  });

  test("补扫分页读处在 flush 窗口时，计数写入等窗口关闭后才投递", async () => {
    storeBlocked(7);
    await prefetchIdentityPolicies([7]);
    const window: { release: () => void; page: Promise<BlocklistIdPage> } = openSweepWindow();

    recordBlocklistParticipantReadability(receipt([7]));
    await Bun.sleep(0);
    expect(identityWrites("blocklist")).toEqual([]);

    window.release();
    await expect(window.page).resolves.toEqual(EMPTY_PAGE);
    await drain();
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META, participantInvalidCount: 1 });

    // 窗口关闭后开始的分页读由自己的 flush 覆盖这次写入。
    await expect(readBlocklistSweepPage(null)).resolves.toEqual(EMPTY_PAGE);
  });

  test("一个窗口关闭时另一个分页读仍在 flush，写入继续等待", async () => {
    storeBlocked(7);
    await prefetchIdentityPolicies([7]);
    const first: { release: () => void; page: Promise<BlocklistIdPage> } = openSweepWindow();
    recordBlocklistParticipantReadability(receipt([7]));
    await Bun.sleep(0);
    const second: { release: () => void; page: Promise<BlocklistIdPage> } = openSweepWindow();

    first.release();
    await expect(first.page).resolves.toEqual(EMPTY_PAGE);
    await Bun.sleep(0);
    expect(identityWrites("blocklist")).toEqual([]);

    second.release();
    await expect(second.page).resolves.toEqual(EMPTY_PAGE);
    await drain();
    expect(lastWrittenData(7)).toEqual({ blockedAt: BLOCKED_AT, meta: META, participantInvalidCount: 1 });
  });

  test("测试隔离重置后，迟到关闭的旧窗口不改变新的窗口计数", async () => {
    const stale: { release: () => void; page: Promise<BlocklistIdPage> } = openSweepWindow();
    expect(blocklistSweepFlushWindows.open).toBe(1);
    resetIdentityStorageCache();
    expect(blocklistSweepFlushWindows.open).toBe(0);
    const current: { release: () => void; page: Promise<BlocklistIdPage> } = openSweepWindow();

    stale.release();
    await expect(stale.page).resolves.toEqual(EMPTY_PAGE);
    expect(blocklistSweepFlushWindows.open).toBe(1);
    current.release();
    await expect(current.page).resolves.toEqual(EMPTY_PAGE);
    expect(blocklistSweepFlushWindows.open).toBe(0);
  });
});
