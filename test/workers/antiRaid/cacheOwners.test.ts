import { installTemporaryMessageWorkerMock } from "../../helpers/temporaryMessageWorkerMock";
installTemporaryMessageWorkerMock();
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ANTI_RAID_CHAT_CACHE_MAX } from
  "../../../packages/consts/antiRaid/cache";
import {
  adminFetches,
  bufferAdminChangeDuringFetch,
  cacheAdminIds,
  chatAdmins,
  getOrCreateAdminFetch,
  pendingAdminChangesDuringFetch,
  resetAdminCache,
  takePendingAdminChanges,
} from "../../../packages/cache/workers/antiRaid/admins";
import {
  cacheLinkedChannel,
  getOrCreateLinkedChannelFetch,
  linkedChannelFetches,
  linkedChannels,
  resetLinkedChannelCache,
} from "../../../packages/cache/workers/antiRaid/linkedChannels";
import {
  joinWindows,
  lockdownApiChains,
  lockdownEntries,
  lockdownRetriggerCooldowns,
} from "../../../packages/cache/workers/antiRaid/lockdown";
import {
  JOIN_WINDOW_CAPACITY,
  JOIN_WINDOW_MS,
  LOCKDOWN_RETRIGGER_COOLDOWN_MS,
} from
  "../../../packages/consts/antiRaid/lockdown";
import type { AntiRaidWorkerEvent } from "../../../packages/types";

const lockdownEvents: AntiRaidWorkerEvent[] = [];
const permissionWrites: Record<string, boolean | undefined>[] = [];
const sentMessages: { chatId: number; text: string }[] = [];
const deletedMessages: { chatId: number; messageId: number }[] = [];
let currentPermissions: Record<string, boolean | undefined> = {};
let sendMessageResult: number | undefined = 700;
const getChat = mock(async (): Promise<{ permissions?: Record<string, boolean | undefined> }> => ({
  permissions: { ...currentPermissions },
}));
const getChatAdministrators = mock(async (): Promise<{
  user: { id: number };
  is_anonymous: boolean;
}[]> => []);
const setChatPermissions = mock(async (
  _chatId: number,
  permissions: Record<string, boolean | undefined>
): Promise<void> => {
  permissionWrites.push({ ...permissions });
  currentPermissions = { ...permissions };
});
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage(event: AntiRaidWorkerEvent): void { lockdownEvents.push(event); } },
});
mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../packages/infra/telegram", () => ({
  telegramApi: {
    getChatAdministrators,
    getChat,
    setChatPermissions,
  },
  sendMessage: async (message: { chatId: number; text: string }): Promise<number | undefined> => {
    sentMessages.push({ chatId: message.chatId, text: message.text });
    return sendMessageResult;
  },
  deleteMessage: async (chatId: number, messageId: number): Promise<boolean> => {
    deletedMessages.push({ chatId, messageId });
    return true;
  },
}));

/** 加锁、公告与恢复都排在同一条串行链上；多让出几次微任务等它们全部结算。 */
async function settleLockdownCalls(): Promise<void> {
  for (let index = 0; index < 8; index++) await Bun.sleep(0);
}

const adminCache = await import("../../../packages/workers/antiRaid/adminCache");
const lockdownRuntime = await import("../../../packages/workers/antiRaid/lockdownRuntime");
const joinWindowRuntime = await import(
  "../../../packages/workers/antiRaid/lockdownJoinWindow"
);

beforeEach(() => {
  resetAdminCache();
  resetLinkedChannelCache();
  lockdownEvents.length = 0;
  permissionWrites.length = 0;
  sentMessages.length = 0;
  deletedMessages.length = 0;
  currentPermissions = {};
  sendMessageResult = 700;
  getChat.mockClear();
  getChat.mockImplementation(async () => ({ permissions: { ...currentPermissions } }));
  getChatAdministrators.mockClear();
  getChatAdministrators.mockResolvedValue([]);
  setChatPermissions.mockClear();
  setChatPermissions.mockImplementation(async (
    _chatId: number,
    permissions: Record<string, boolean | undefined>
  ): Promise<void> => {
    permissionWrites.push({ ...permissions });
    currentPermissions = { ...permissions };
  });
  for (const window of joinWindows.values()) {
    if (window.resetTimeout !== undefined) clearTimeout(window.resetTimeout);
  }
  for (const entry of lockdownEntries.values()) {
    if (entry.restoreTimer !== undefined) clearTimeout(entry.restoreTimer);
    if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
  }
  joinWindows.clear();
  lockdownEntries.clear();
  lockdownApiChains.clear();
  // 作废冷却按群留存，不清就会漏给下一个用例（stopLockdownRuntime 同样清它）。
  lockdownRetriggerCooldowns.clear();
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

  test("整表清空后陈旧拉取既不删新槽位，也不把旧快照写回去", async () => {
    // resetAdminCache()（Worker 停机路径/测试隔离）会在拉取在途时清空整张表。
    // finally 无条件 delete 的话删掉的是**新** fetch 的槽位，去重失效，下一个
    // 调用者会在入群验证使用的 query 类别 429 FIFO 上再发起一次全量拉取。
    let resolveStale!: (admins: { user: { id: number }; is_anonymous: boolean }[]) => void;
    getChatAdministrators.mockImplementationOnce(
      () => new Promise((resolve) => { resolveStale = resolve; })
    );
    const stale = adminCache.fetchAdminIds(-1010);
    // 陈旧拉取期间到达的降权：reset 会把它一起丢掉。
    adminCache.applyAdminChange(-1010, 42, false);

    resetAdminCache();

    let resolveFresh!: (admins: { user: { id: number }; is_anonymous: boolean }[]) => void;
    getChatAdministrators.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFresh = resolve; })
    );
    const fresh = adminCache.fetchAdminIds(-1010);
    const freshSlot: Promise<Set<number>> | undefined = adminFetches.get(-1010);
    expect(freshSlot).toBeDefined();

    // 陈旧拉取此刻才 settle：既不能删掉新槽位（去重失效 = 共享 Telegram 队列上多一次
    // 全量拉取），也不能把 reset 前的快照灌回刚清空的表——那样被降权者会在整个
    // ADMIN_CACHE_TTL_MS 内继续留在邀请人豁免集合里，他拉进来的人全部免入群验证。
    resolveStale([{ user: { id: 42 }, is_anonymous: false }]);
    await expect(stale).resolves.toEqual(new Set([42]));
    expect(adminFetches.get(-1010)).toBe(freshSlot!);
    expect(chatAdmins.has(-1010)).toBeFalse();

    resolveFresh([{ user: { id: 7 }, is_anonymous: false }]);
    await expect(fresh).resolves.toEqual(new Set([7]));
    expect(chatAdmins.get(-1010)?.adminIds).toEqual(new Set([7]));
    expect(adminFetches.has(-1010)).toBeFalse();
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
  test("入群滑窗保持数值硬顶并复用每群唯一 timer", async () => {
    const chatId: number = -1099;
    const base: number = Date.now();
    lockdownRuntime.recordJoin(chatId, base);
    const firstTimer: ReturnType<typeof setTimeout> | undefined =
      joinWindows.get(chatId)?.resetTimeout;

    for (let index: number = 1; index < JOIN_WINDOW_CAPACITY + 100; index += 1) {
      lockdownRuntime.recordJoin(chatId, base + index);
    }

    const saturated = joinWindows.get(chatId);
    expect(saturated?.timestamps.size).toBe(JOIN_WINDOW_CAPACITY);
    expect(saturated?.overflowThrough).toBeDefined();
    expect(saturated?.resetTimeout).toBe(firstTimer);
    expect(saturated?.expiresAt).toBe(
      base + JOIN_WINDOW_CAPACITY + 99 + JOIN_WINDOW_MS
    );

    // 被覆盖的所有值过期后恢复精确计数，不让饱和标记永久钉住群。
    lockdownRuntime.recordJoin(chatId, base + JOIN_WINDOW_MS + JOIN_WINDOW_CAPACITY + 100);
    const recovered = joinWindows.get(chatId);
    expect(recovered?.timestamps.size).toBe(1);
    expect(recovered?.overflowThrough).toBeUndefined();
    await settleLockdownCalls();
  });

  test("入群滑窗在墙钟回拨时丢弃失效的饱和证明", () => {
    const chatId: number = -1098;
    const futureBase: number = 5_000;
    for (let index: number = 0; index < JOIN_WINDOW_CAPACITY + 1; index += 1) {
      joinWindowRuntime.recordJoinWindow(chatId, futureBase + index);
    }

    expect(joinWindowRuntime.recordJoinWindow(chatId, 0)).toBeUndefined();
    expect(joinWindows.get(chatId)?.timestamps.size).toBe(1);
    expect(joinWindows.get(chatId)?.overflowThrough).toBeUndefined();
  });

  test("群 teardown 清除尚未到期的入群滑窗", () => {
    const chatId = -1000;
    lockdownRuntime.recordJoin(chatId, Date.now());
    expect(joinWindows.has(chatId)).toBeTrue();

    lockdownRuntime.deactivateLockdownChat(chatId);
    expect(joinWindows.has(chatId)).toBeFalse();
  });

  test("占位一落地就先在群里报告封锁，落盘回执前绝不修改权限", async () => {
    const chatId = -1001;
    currentPermissions = { can_invite_users: true, can_send_messages: true };
    cacheAdminIds(chatId, new Set(), Date.now());
    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await settleLockdownCalls();

    // 公告必须先于任何权限写落地：从占位那一刻起入群就被直接请出去了。
    expect(sentMessages[0]?.text).toContain("60 秒内冲进来了 46 个");
    const applying = lockdownEvents.find((event) => event.type === "lockdown");
    expect(applying).toMatchObject({
      type: "lockdown",
      phase: "applying",
      announced: true,
      announcementMessageId: 700,
    });
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
    await settleLockdownCalls();
    expect(permissionWrites[0]).toEqual({
      can_invite_users: false,
      can_send_messages: false,
      can_send_polls: true,
    });
    expect(getChat).toHaveBeenCalledTimes(2);
    const active = lockdownEvents.findLast((event) =>
      event.type === "lockdown" && event.phase === "active"
    );
    expect(active).toMatchObject({
      type: "lockdown",
      phase: "active",
      announced: true,
      announcementMessageId: 700,
    });
    if (active?.type !== "lockdown") throw new Error("missing active intent");

    lockdownRuntime.handleLockdownPersisted({
      type: "lockdownPersisted",
      chatId,
      phase: "active",
      intentId: active.intentId,
    });
    await settleLockdownCalls();

    // 公告只发一次：进入 ACTIVE 不重发。
    expect(sentMessages).toHaveLength(1);
  });

  test("作废冷却到期后可以重新进入私密模式", async () => {
    const chatId = -1011;
    currentPermissions = { can_invite_users: true, can_send_messages: true };
    cacheAdminIds(chatId, new Set(), Date.now());
    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await settleLockdownCalls();
    const applying = lockdownEvents.find((event) =>
      event.type === "lockdown" && event.chatId === chatId
    );
    if (applying?.type !== "lockdown") throw new Error("missing applying intent");
    lockdownRuntime.handleLockdownPersistFailed({
      type: "lockdownPersistFailed",
      chatId,
      phase: "applying",
      intentId: applying.intentId,
    });
    await settleLockdownCalls();
    expect(lockdownRetriggerCooldowns.has(chatId)).toBeTrue();

    // 冷却是暂停不是永久关闭：过了这段时间，同样的刷群必须能再次锁上。
    const afterCooldown = Date.now() + LOCKDOWN_RETRIGGER_COOLDOWN_MS + 1;
    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, afterCooldown);
    await settleLockdownCalls();

    expect(lockdownEntries.has(chatId)).toBeTrue();
    expect(lockdownRetriggerCooldowns.has(chatId)).toBeFalse();
  });

  test("群停用会一并丢掉作废冷却：重新开启不背着旧的不设防", async () => {
    const chatId = -1012;
    currentPermissions = { can_invite_users: true, can_send_messages: true };
    cacheAdminIds(chatId, new Set(), Date.now());
    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await settleLockdownCalls();
    const applying = lockdownEvents.find((event) =>
      event.type === "lockdown" && event.chatId === chatId
    );
    if (applying?.type !== "lockdown") throw new Error("missing applying intent");
    lockdownRuntime.handleLockdownPersistFailed({
      type: "lockdownPersistFailed",
      chatId,
      phase: "applying",
      intentId: applying.intentId,
    });
    await settleLockdownCalls();
    expect(lockdownRetriggerCooldowns.has(chatId)).toBeTrue();

    lockdownRuntime.deactivateLockdownChat(chatId);
    expect(lockdownRetriggerCooldowns.has(chatId)).toBeFalse();

    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await settleLockdownCalls();
    expect(lockdownEntries.has(chatId)).toBeTrue();
  });

  test("锁定期内继续灌人不再推后恢复时刻，也不重新落盘", async () => {
    const chatId = -1009;
    currentPermissions = { can_invite_users: true, can_send_messages: true };
    cacheAdminIds(chatId, new Set(), Date.now());
    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await settleLockdownCalls();

    const applying = lockdownEvents.find((event) =>
      event.type === "lockdown" && event.chatId === chatId
    );
    if (applying?.type !== "lockdown") throw new Error("missing applying intent");
    lockdownRuntime.handleLockdownPersisted({
      type: "lockdownPersisted",
      chatId,
      phase: "applying",
      intentId: applying.intentId,
    });
    await settleLockdownCalls();

    const restoreAt = lockdownEntries.get(chatId)?.restoreAt;
    expect(restoreAt).toBeDefined();
    const publishedBefore = lockdownEvents.filter((event) =>
      event.type === "lockdown" && event.chatId === chatId
    ).length;

    // ACTIVE 状态下持续入群不得重排倒计时，否则同一轮会被无限续期。
    for (let index = 0; index < 20; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await settleLockdownCalls();

    expect(lockdownEntries.get(chatId)?.restoreAt).toBe(restoreAt!);
    expect(lockdownEvents.filter((event) =>
      event.type === "lockdown" && event.chatId === chatId
    )).toHaveLength(publishedBefore);
  });

  test("解除后入群滑窗清零：再锁一轮必须重新攒够阈值", async () => {
    const chatId = -1010;
    currentPermissions = { can_invite_users: false, can_send_messages: true };
    for (let index = 0; index < 10; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    expect(joinWindows.has(chatId)).toBeTrue();

    lockdownRuntime.adoptLockdowns([{
      chatId,
      phase: "restoring",
      intentId: 13,
      originalPermissions: { can_invite_users: true, can_send_messages: true },
      announced: false,
      remainingMs: 0,
    }]);
    await settleLockdownCalls();

    expect(lockdownEvents.some((event) => event.type === "unlock" && event.chatId === chatId)).toBeTrue();
    expect(joinWindows.has(chatId)).toBeFalse();
  });

  test("解除封锁 → 删掉群里那条封锁公告，再发解除通知", async () => {
    const chatId = -1007;
    currentPermissions = { can_invite_users: false, can_send_messages: true };
    lockdownRuntime.adoptLockdowns([{
      chatId,
      phase: "restoring",
      intentId: 12,
      originalPermissions: { can_invite_users: true, can_send_messages: true },
      announced: true,
      announcementMessageId: 640,
      remainingMs: 0,
    }]);
    await settleLockdownCalls();

    expect(deletedMessages).toEqual([{ chatId, messageId: 640 }]);
    expect(sentMessages[0]?.text).toContain("解除限制");
  });

  test("落盘失败 → 撤销占位、撤掉公告、报解锁，并在冷却期内不再触发", async () => {
    const chatId = -1008;
    currentPermissions = { can_invite_users: true, can_send_messages: true };
    cacheAdminIds(chatId, new Set(), Date.now());
    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await settleLockdownCalls();

    const applying = lockdownEvents.find((event) =>
      event.type === "lockdown" && event.chatId === chatId
    );
    if (applying?.type !== "lockdown") throw new Error("missing applying intent");
    expect(lockdownEntries.has(chatId)).toBeTrue();

    lockdownRuntime.handleLockdownPersistFailed({
      type: "lockdownPersistFailed",
      chatId,
      phase: "applying",
      intentId: applying.intentId,
    });
    await settleLockdownCalls();

    // 落盘失败必须清除 APPLYING 占位，不能留下永久秒踢且无恢复计时的状态。
    expect(lockdownEntries.has(chatId)).toBeFalse();
    expect(permissionWrites).toEqual([]);
    expect(deletedMessages).toEqual([{ chatId, messageId: 700 }]);
    expect(lockdownEvents.some((event) => event.type === "unlock" && event.chatId === chatId)).toBeTrue();

    // 冷却期内继续刷群也不再重来一轮公告与 API 往返。
    sentMessages.length = 0;
    for (let index = 0; index < 46; index++) lockdownRuntime.recordJoin(chatId, Date.now());
    await settleLockdownCalls();
    expect(lockdownEntries.has(chatId)).toBeFalse();
    expect(sentMessages).toEqual([]);
  });

  test("重建 applying 也合并当前权限，并使用未知人数文案", async () => {
    currentPermissions = { can_invite_users: true, can_send_messages: false, can_send_polls: true };
    lockdownRuntime.adoptLockdowns([{
      chatId: -1004,
      phase: "applying",
      intentId: 10,
      originalPermissions: { can_invite_users: true, can_send_messages: true },
      announced: false,
      remainingMs: 0,
    }]);
    await Bun.sleep(0);

    expect(permissionWrites[0]).toEqual({
      can_invite_users: false,
      can_send_messages: false,
      can_send_polls: true,
    });
    expect(getChat).toHaveBeenCalledTimes(1);
    const active = lockdownEvents.findLast((event) =>
      event.type === "lockdown" && event.chatId === -1004 && event.phase === "active"
    );
    if (active?.type !== "lockdown") throw new Error("missing adopted active intent");
    lockdownRuntime.handleLockdownPersisted({
      type: "lockdownPersisted",
      chatId: -1004,
      phase: "active",
      intentId: active.intentId,
    });
    await Bun.sleep(0);

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
      announced: true,
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
      announced: false,
      remainingMs: 0,
    }]);
    await Bun.sleep(0);
    // 管理员在锁定期内已主动重新开启邀请时，以当前显式修改为准。
    expect(permissionWrites[0]?.can_invite_users).toBeTrue();
  });

  test("重建 RECONCILING 时纠偏失败保留状态并安排重试", async () => {
    const chatId = -1006;
    currentPermissions = { can_invite_users: true, can_send_messages: true };
    setChatPermissions.mockRejectedValueOnce(new Error("temporary failure"));

    lockdownRuntime.adoptLockdowns([{
      chatId,
      phase: "reconciling",
      intentId: 11,
      originalPermissions: { can_invite_users: true, can_send_messages: true },
      announced: true,
      remainingMs: 60_000,
    }]);
    await Bun.sleep(0);

    expect(lockdownEntries.get(chatId)?.state.kind).toBe("reconciling");
    expect(lockdownEntries.get(chatId)?.restoreTimer).toBeDefined();
    expect(lockdownEntries.get(chatId)?.retryTimer).toBeDefined();
    expect(lockdownEvents.some((event) =>
      event.type === "lockdown" && event.phase === "active"
    )).toBeFalse();
  });
});
