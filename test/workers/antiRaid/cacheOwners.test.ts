import { beforeEach, describe, expect, test } from "bun:test";
import { ANTI_RAID_CHAT_CACHE_MAX } from "../../../src/consts/antiRaid";
import {
  adminFetches,
  bufferAdminChangeDuringFetch,
  cacheAdminIds,
  chatAdmins,
  getOrCreateAdminFetch,
  pendingAdminChangesDuringFetch,
  resetAdminCache,
  takePendingAdminChanges,
} from "../../../src/cache/antiRaid/admins";
import {
  cacheLinkedChannel,
  getOrCreateLinkedChannelFetch,
  linkedChannelFetches,
  linkedChannels,
  resetLinkedChannelCache,
} from "../../../src/cache/antiRaid/linkedChannels";

beforeEach(() => {
  resetAdminCache();
  resetLinkedChannelCache();
});

describe("Anti-Raid cache owners", () => {
  test("管理员与关联频道快照分别保持 500 群硬顶", () => {
    for (let chatId = 1; chatId <= ANTI_RAID_CHAT_CACHE_MAX; chatId++) {
      cacheAdminIds(chatId, new Set([chatId]), chatId);
      cacheLinkedChannel(chatId, chatId % 2 === 0, chatId);
    }

    cacheAdminIds(ANTI_RAID_CHAT_CACHE_MAX + 1, new Set(), 999);
    cacheLinkedChannel(ANTI_RAID_CHAT_CACHE_MAX + 1, true, 999);

    expect(chatAdmins).toHaveLength(ANTI_RAID_CHAT_CACHE_MAX);
    expect(chatAdmins.has(1)).toBeFalse();
    expect(chatAdmins.has(ANTI_RAID_CHAT_CACHE_MAX + 1)).toBeTrue();
    expect(linkedChannels).toHaveLength(ANTI_RAID_CHAT_CACHE_MAX);
    expect(linkedChannels.has(1)).toBeFalse();
    expect(linkedChannels.has(ANTI_RAID_CHAT_CACHE_MAX + 1)).toBeTrue();
  });

  test("管理员 owner 去重在途请求，并按用户合并拉取期间的最新增量", async () => {
    let resolveFetch!: (value: Set<number>) => void;
    let createCalls: number = 0;
    const create = (): Promise<Set<number>> => {
      createCalls++;
      return new Promise((resolve) => { resolveFetch = resolve; });
    };

    const first = getOrCreateAdminFetch(-1001, create);
    const second = getOrCreateAdminFetch(-1001, create);
    expect(second).toBe(first);
    expect(createCalls).toBe(1);

    bufferAdminChangeDuringFetch(-1001, 42, true);
    bufferAdminChangeDuringFetch(-1001, 42, false);
    bufferAdminChangeDuringFetch(-1001, 43, true);
    expect([...takePendingAdminChanges(-1001)!]).toEqual([[42, false], [43, true]]);
    expect(pendingAdminChangesDuringFetch.has(-1001)).toBeFalse();

    resolveFetch(new Set([1]));
    expect(await first).toEqual(new Set([1]));
    expect(adminFetches.has(-1001)).toBeFalse();

    bufferAdminChangeDuringFetch(-1001, 99, true);
    expect(pendingAdminChangesDuringFetch.has(-1001)).toBeFalse();
  });

  test("关联频道 owner 去重在途请求并在 settle 后释放槽位", async () => {
    let resolveFetch!: () => void;
    let createCalls: number = 0;
    const create = (): Promise<void> => {
      createCalls++;
      return new Promise((resolve) => { resolveFetch = resolve; });
    };

    const first = getOrCreateLinkedChannelFetch(-1001, create);
    const second = getOrCreateLinkedChannelFetch(-1001, create);
    expect(second).toBe(first);
    expect(createCalls).toBe(1);
    expect(linkedChannelFetches.has(-1001)).toBeTrue();

    resolveFetch();
    await first;
    expect(linkedChannelFetches.has(-1001)).toBeFalse();
  });
});
