import { beforeEach, describe, expect, mock, test } from "bun:test";
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
import { joinWindows, lockdownApiChains, lockdownEntries } from "../../../src/cache/antiRaid/lockdown";
import type { AntiRaidWorkerEvent } from "../../../src/types";

const lockdownEvents: AntiRaidWorkerEvent[] = [];
const permissionWrites: Record<string, boolean | undefined>[] = [];
const sentMessages: { chatId: number; text: string }[] = [];
let currentPermissions: Record<string, boolean | undefined> = {};
const getChat = mock(async (): Promise<{ permissions?: Record<string, boolean | undefined> }> => ({
  permissions: { ...currentPermissions },
}));
const getChatAdministrators = mock(async (): Promise<{
  user: { id: number };
  is_anonymous: boolean;
}[]> => []);
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(event: AntiRaidWorkerEvent): void { lockdownEvents.push(event); } },
});
mock.module("../../../src/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../src/infra/telegram", () => ({
  joinVerificationApi: {
    getChatAdministrators,
    getChat,
    setChatPermissions: async (_chatId: number, permissions: Record<string, boolean | undefined>): Promise<void> => {
      permissionWrites.push({ ...permissions });
      currentPermissions = { ...permissions };
    },
  },
  sendMessage: async (message: { chatId: number; text: string }): Promise<undefined> => {
    sentMessages.push(message);
    return undefined;
  },
}));

const adminCache = await import("../../../src/workers/antiRaid/adminCache");
const lockdownRuntime = await import("../../../src/workers/antiRaid/lockdownRuntime");

beforeEach(() => {
  resetAdminCache();
  resetLinkedChannelCache();
  lockdownEvents.length = 0;
  permissionWrites.length = 0;
  sentMessages.length = 0;
  currentPermissions = {};
  getChat.mockClear();
  getChat.mockImplementation(async () => ({ permissions: { ...currentPermissions } }));
  getChatAdministrators.mockClear();
  getChatAdministrators.mockResolvedValue([]);
  for (const window of joinWindows.values()) clearTimeout(window.resetTimeout);
  for (const entry of lockdownEntries.values()) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
  }
  joinWindows.clear();
  lockdownEntries.clear();
  lockdownApiChains.clear();
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

  test("全量管理员快照只缓存身份可归因的非匿名管理员", async () => {
    getChatAdministrators.mockResolvedValueOnce([
      { user: { id: 41 }, is_anonymous: false },
      { user: { id: 42 }, is_anonymous: true },
    ]);

    await expect(adminCache.fetchAdminIds(-1002)).resolves.toEqual(new Set([41]));
    expect(chatAdmins.get(-1002)?.adminIds).toEqual(new Set([41]));
  });

  test("拉取在途期间到达的增量重放在快照之上，不被迟到的 resolve 覆盖", async () => {
    let resolveAdmins!: (admins: { user: { id: number }; is_anonymous: boolean }[]) => void;
    getChatAdministrators.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAdmins = resolve; })
    );

    const fetching = adminCache.fetchAdminIds(-1003);
    // 快照还在路上时 chat_member 已经权威地告知：42 升管理员、41 被撤。
    adminCache.applyAdminChange(-1003, 42, true);
    adminCache.applyAdminChange(-1003, 41, false);
    resolveAdmins([{ user: { id: 41 }, is_anonymous: false }]);

    await expect(fetching).resolves.toEqual(new Set([42]));
    expect(chatAdmins.get(-1003)?.adminIds).toEqual(new Set([42]));
    expect(pendingAdminChangesDuringFetch.has(-1003)).toBeFalse();
  });

  test("拉取失败连同尚未重放的增量一起丢弃，不留没有基底的孤立增量", async () => {
    getChatAdministrators.mockImplementationOnce(async () => {
      throw new Error("getChatAdministrators failed");
    });

    const failing = adminCache.fetchAdminIds(-1004);
    adminCache.applyAdminChange(-1004, 42, true);

    await expect(failing).rejects.toThrow("getChatAdministrators failed");
    expect(pendingAdminChangesDuringFetch.has(-1004)).toBeFalse();
    expect(chatAdmins.has(-1004)).toBeFalse();
  });

  test("增量只原地改已有快照；没拉取过的群不建条目也不留增量", () => {
    cacheAdminIds(-1005, new Set([41]), Date.now());

    adminCache.applyAdminChange(-1005, 42, true);
    adminCache.applyAdminChange(-1005, 41, false);
    expect(chatAdmins.get(-1005)?.adminIds).toEqual(new Set([42]));

    adminCache.applyAdminChange(-1006, 42, true);
    expect(chatAdmins.has(-1006)).toBeFalse();
    expect(pendingAdminChangesDuringFetch.has(-1006)).toBeFalse();
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

describe("Lockdown write-ahead runtime", () => {
  test("群 teardown 清除尚未到期的入群滑窗", () => {
    const chatId = -1000;
    lockdownRuntime.recordJoin(chatId, Date.now());
    expect(joinWindows.has(chatId)).toBeTrue();

    lockdownRuntime.deactivateLockdownChat(chatId);
    expect(joinWindows.has(chatId)).toBeFalse();
  });

  test("getChat 后先发布 applying，落盘回执前绝不修改权限", async () => {
    const chatId = -1001;
    currentPermissions = { can_invite_users: true, can_send_messages: true };
    cacheAdminIds(chatId, new Set(), Date.now());
    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await Bun.sleep(0);

    const applying = lockdownEvents.find((event) => event.type === "lockdown");
    expect(applying).toMatchObject({ type: "lockdown", phase: "applying" });
    expect(permissionWrites).toEqual([]);
    if (applying?.type !== "lockdown") throw new Error("missing applying intent");

    // applying intent 落盘期间管理员调整了其它权限；提交必须重新读取并保留。
    currentPermissions = { can_invite_users: true, can_send_messages: false, can_send_polls: true };
    lockdownRuntime.handleLockdownPersisted({
      type: "lockdownPersisted",
      chatId,
      phase: "applying",
      intentId: applying.intentId,
    });
    await Bun.sleep(0);
    expect(permissionWrites[0]).toEqual({
      can_invite_users: false,
      can_send_messages: false,
      can_send_polls: true,
    });
    expect(getChat).toHaveBeenCalledTimes(2);
    expect(lockdownEvents.some((event) => event.type === "lockdown" && event.phase === "active")).toBeTrue();
    expect(sentMessages[0]?.text).toContain("60 秒内冲进来了 46 个");
  });

  test("重建 applying 也合并当前权限，并使用未知人数文案", async () => {
    currentPermissions = { can_invite_users: true, can_send_messages: false, can_send_polls: true };
    lockdownRuntime.adoptLockdowns([{
      chatId: -1004,
      phase: "applying",
      intentId: 10,
      originalPermissions: { can_invite_users: true, can_send_messages: true },
      remainingMs: 0,
    }]);
    await Bun.sleep(0);

    expect(permissionWrites[0]).toEqual({
      can_invite_users: false,
      can_send_messages: false,
      can_send_polls: true,
    });
    expect(getChat).toHaveBeenCalledTimes(1);
    expect(sentMessages[0]?.text).toContain("检测到短时间内大量成员入群");
    expect(sentMessages[0]?.text).not.toContain("0 个");
  });

  test("提交前刷新权限缺失时不写 Telegram，并清除已落盘 applying intent", async () => {
    const chatId = -1005;
    currentPermissions = { can_invite_users: true, can_send_messages: true };
    cacheAdminIds(chatId, new Set(), Date.now());
    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await Bun.sleep(0);

    const applying = lockdownEvents.find((event) => event.type === "lockdown");
    if (applying?.type !== "lockdown") throw new Error("missing applying intent");
    getChat.mockResolvedValueOnce({});

    lockdownRuntime.handleLockdownPersisted({
      type: "lockdownPersisted",
      chatId,
      phase: "applying",
      intentId: applying.intentId,
    });
    await Bun.sleep(0);

    expect(permissionWrites).toEqual([]);
    expect(lockdownEntries.has(chatId)).toBeFalse();
    expect(lockdownEvents.some((event) => event.type === "unlock" && event.chatId === chatId)).toBeTrue();
  });

  test("重建会继续 applying/restoring，恢复仅合并 invite 字段", async () => {
    currentPermissions = { can_invite_users: false, can_send_messages: false, can_send_polls: true };
    lockdownRuntime.adoptLockdowns([{
      chatId: -1002,
      phase: "restoring",
      intentId: 8,
      originalPermissions: { can_invite_users: true, can_send_messages: true },
      remainingMs: 0,
    }]);
    await Bun.sleep(0);
    expect(permissionWrites[0]).toEqual({
      can_invite_users: true,
      can_send_messages: false,
      can_send_polls: true,
    });
    expect(lockdownEvents.some((event) => event.type === "unlock" && event.chatId === -1002)).toBeTrue();

    permissionWrites.length = 0;
    currentPermissions = { can_invite_users: true, can_send_messages: false };
    lockdownRuntime.adoptLockdowns([{
      chatId: -1003,
      phase: "restoring",
      intentId: 9,
      originalPermissions: { can_invite_users: false, can_send_messages: true },
      remainingMs: 0,
    }]);
    await Bun.sleep(0);
    // 管理员在锁定期内已主动重新开启邀请时，以当前显式修改为准。
    expect(permissionWrites[0]?.can_invite_users).toBeTrue();
  });
});
