import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerMessage } from "../../../packages/types";
import type { DiskBusinessMessage } from "../../../packages/types/diskIO";

const workerPosts: AntiRaidWorkerMessage[] = [];
const diskPosts: DiskBusinessMessage[] = [];
const deliveryOrder: string[] = [];
const flushDiskIODomain = mock(async (): Promise<string> => {
  deliveryOrder.push("disk-flush");
  return "flushed";
});

mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../packages/infra/storage/stateStore", () => ({
  clearChatStateField: (): boolean => false,
  getChatState: () => ({}),
  getAllChatStates: () => new Map(),
  getOrCreateChatState: () => ({}),
  saveState: async (): Promise<void> => {},
  flushStateToDisk: async (): Promise<string> => "flushed",
  saveStateInBackground: (): void => {},
}));
mock.module("../../../packages/infra/telegram/actions", () => ({
  answerCallbackQuery: async (): Promise<boolean> => true,
  // 广告处置的群内播报用的，本文件不触发；整份模块被替换掉时缺了它们会在
  // import 阶段就报 Export not found。
  sendMessage: async (): Promise<number | undefined> => undefined,
  deleteMessageAfter: (): void => {},
}));
mock.module("../../../packages/infra/telegram/client", () => ({ joinVerificationApi: { kind: "guard-api" } }));
mock.module("../../../packages/infra/botAdmin", () => ({
  isBotAdminIn: async (): Promise<boolean> => true,
  markBotAdminObserved: async (): Promise<void> => {},
}));
mock.module("../../../packages/libs/supervisedWorker", () => ({
  superviseWorker: () => ({
    init(): void {},
    post: (message: AntiRaidWorkerMessage): boolean => {
      workerPosts.push(message);
      deliveryOrder.push(`worker-${message.type}`);
      return true;
    },
    terminate: async (): Promise<void> => {},
  }),
}));
mock.module("../../../packages/infra/diskIO", () => ({
  flushDiskIO: async (): Promise<string> => "flushed",
  flushDiskIODomain,
  lastFailedDiskIODomains: (): readonly string[] => [],
  onDiskIORespawn: (): void => {},
  postDiskIO: (message: DiskBusinessMessage): boolean => {
    diskPosts.push(message);
    deliveryOrder.push(`disk-${message.type}`);
    return true;
  },
  postDiskIODiagnostic: (message: DiskBusinessMessage): boolean => {
    diskPosts.push(message);
    deliveryOrder.push(`disk-${message.type}`);
    return true;
  },
}));
mock.module("../../../packages/workers/antiRaid/persistence", () => ({
  flushDiskIO: async (): Promise<string> => "flushed",
  postDiskIO: (): void => {},
  onDiskIORespawn: (): void => {},
  onVerificationPersisted: (): void => {},
}));

const { handleChatMemberUpdate, handleGroupJoinVerification } = await import("../../../packages/antiRaid");
const { blockedUserIds, pendingBlockedRemovals } = await import("../../../packages/cache/blocklist");
const { recentBlockedJoinCounts } = await import("../../../packages/cache/antiRaid/blocklistGuard");
const { unblockUser } = await import("../../../packages/infra/blocklist");

/** 一条「从不在群里变成群成员」的 chat_member 更新。 */
function joinUpdate(userId: number, status: "member" | "administrator" = "member"): never {
  return {
    chatMember: {
      chat: { id: -1001, type: "supergroup" },
      from: { id: 5, is_bot: false, first_name: "Inviter" },
      old_chat_member: { status: "left", user: { id: userId, is_bot: false, first_name: "Zako" } },
      new_chat_member: { status, user: { id: userId, is_bot: false, first_name: "Zako" } },
      date: 1,
    },
    me: { id: 999 },
  } as never;
}

/** 本次投给 Worker 的黑名单处置消息。 */
function removals(): AntiRaidWorkerMessage[] {
  return workerPosts.filter((message) => message.type === "removeBlockedMembers");
}

/** 本次投给 Worker 的 join 消息（开验证窗口的那条）。 */
function joins(): AntiRaidWorkerMessage[] {
  return workerPosts.filter((message) => message.type === "join");
}

beforeEach(() => {
  workerPosts.length = 0;
  diskPosts.length = 0;
  deliveryOrder.length = 0;
  flushDiskIODomain.mockClear();
  blockedUserIds.clear();
  pendingBlockedRemovals.clear();
  recentBlockedJoinCounts.clear();
});

describe("黑名单成员入群秒踢", () => {
  test("chat_member 路径：投处置给 Worker，不投 join（不开验证窗口）", async () => {
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleChatMemberUpdate(joinUpdate(42));

    // 判定在主线程（名单是主线程状态），执行在 Worker：主线程只投一条处置。
    // probeMembership=false——这是刚到的入群更新，人确定在群里，不必再探。
    expect(removals()).toHaveLength(1);
    expect(removals()[0]).toMatchObject({
      type: "removeBlockedMembers",
      chatId: -1001,
      userIds: [42],
      probeMembership: false,
      // 不投 join 就没人替这次入群记刷群计数，处置消息必须把时刻带上。
      joinedAt: expect.any(Number),
    });
    // 未销账的批次要能被重投，编号是它的身份。
    expect(pendingBlockedRemovals.size).toBe(1);
    expect(joins()).toHaveLength(0);
    expect(diskPosts.at(-1)).toMatchObject({
      type: "blocklistRemovals",
      removals: [[expect.any(Number), expect.objectContaining({
        params: expect.objectContaining({ chatId: -1001, userIds: [42] }),
      })]],
    });
    expect(deliveryOrder.indexOf("disk-blocklistRemovals")).toBeLessThan(
      deliveryOrder.indexOf("disk-flush")
    );
    expect(deliveryOrder.indexOf("disk-flush")).toBeLessThan(
      deliveryOrder.indexOf("worker-removeBlockedMembers")
    );
  });

  test("管理员身份也救不了：黑名单优先于一切入群豁免", async () => {
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleChatMemberUpdate(joinUpdate(42, "administrator"));

    expect(removals()).toHaveLength(1);
    expect(joins()).toHaveLength(0);
  });

  test("outbox 未落盘时不把处置投给 Worker，也不确认这条 update", async () => {
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    flushDiskIODomain.mockResolvedValueOnce("failed");

    await expect(handleChatMemberUpdate(joinUpdate(42))).rejects.toThrow(
      "Blocklist removal outbox flush failed"
    );

    expect(removals()).toHaveLength(0);
    expect(pendingBlockedRemovals.size).toBe(1);
    expect(diskPosts.at(-1)?.type).toBe("blocklistRemovals");
  });

  test("outbox flush 等待期间解除拉黑时，先持久化取消且不投递旧处置", async () => {
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    let releaseFirstFlush: ((result: string) => void) | undefined;
    flushDiskIODomain.mockImplementationOnce(
      (): Promise<string> => new Promise<string>((resolve: (result: string) => void): void => {
        releaseFirstFlush = resolve;
      })
    );

    const handling: Promise<void> = handleChatMemberUpdate(joinUpdate(42));
    // markBotAdminObserved 与 write-ahead 各跨一个 microtask；等第一轮 snapshot
    // 已排队且 flush 真正挂起，再模拟并发到达的 /unblock。
    await Promise.resolve();
    await Promise.resolve();
    expect(flushDiskIODomain).toHaveBeenCalledTimes(1);
    expect(unblockUser(42)).toBeTrue();
    if (releaseFirstFlush === undefined) throw new Error("Expected the first outbox flush to be pending.");
    releaseFirstFlush("flushed");

    await handling;

    expect(removals()).toHaveLength(0);
    expect(pendingBlockedRemovals.size).toBe(0);
    // 发现权威任务已取消后还要再 flush 一次空快照，不能只依赖 /unblock
    // 排队但尚未确认的 cleanup。
    expect(flushDiskIODomain).toHaveBeenCalledTimes(2);
    expect(diskPosts.at(-1)).toMatchObject({
      type: "blocklistRemovals",
      removals: [],
    });
  });

  test("不在名单里的人照常走验证，不投任何处置", async () => {
    await handleChatMemberUpdate(joinUpdate(43));

    expect(removals()).toHaveLength(0);
    expect(joins()).toHaveLength(1);
  });

  test("new_chat_members 服务消息路径：黑名单的踢掉，同批其他人照常验证", async () => {
    // 两条路径都要拦：群组隐藏入群消息时只有 chat_member 会到，而 chat_member
    // 需要管理员权限才送达，缺哪一条都会漏。
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    const claimed: boolean = await handleGroupJoinVerification({
      message_id: 10,
      date: 1,
      chat: { id: -1001, type: "supergroup" },
      new_chat_members: [
        { id: 42, is_bot: false, first_name: "Zako" },
        { id: 43, is_bot: false, first_name: "Normal" },
      ],
    } as never, 999);

    expect(claimed).toBeTrue();
    expect(removals()).toHaveLength(1);
    expect(removals()[0]).toMatchObject({
      type: "removeBlockedMembers",
      chatId: -1001,
      userIds: [42],
      probeMembership: false,
      // 这一路带得到入群公告；不投 join 就没人再管它，交给处置一并删。
      announcementMessageId: 10,
    });
    expect(joins()).toHaveLength(1);
    expect(joins()[0]).toMatchObject({ member: { id: 43 } });
  });

  test("同一次入群被两条路径各认领一次时，只带一次 joinedAt", async () => {
    // 处置这一路没有 joinCreatesNewRecord 那道去重闸（普通入群靠它）。两条都
    // 带 joinedAt 就是 recordJoin 两次，反刷群阈值对黑名单账号实际减半，整群
    // 被提前打进私密模式，普通成员的发言权跟着被收走。
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleChatMemberUpdate(joinUpdate(42));
    await handleGroupJoinVerification({
      message_id: 10,
      date: 1,
      chat: { id: -1001, type: "supergroup" },
      new_chat_members: [{ id: 42, is_bot: false, first_name: "Zako" }],
    } as never, 999);

    expect(removals()).toHaveLength(2);
    expect(removals()[0]).toMatchObject({ joinedAt: expect.any(Number) });
    // 第二条仍要投（隐藏入群消息的群只有 chat_member 会到，缺哪条都会漏），
    // 但不再重复记账；公告 id 照带，删公告本来就是幂等的。
    expect((removals()[1] as { joinedAt?: number }).joinedAt).toBeUndefined();
    expect(removals()[1]).toMatchObject({ announcementMessageId: 10 });
  });

  test("不同群、不同人的入群各自记一次账", async () => {
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    blockedUserIds.set(43, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleChatMemberUpdate(joinUpdate(42));
    await handleChatMemberUpdate(joinUpdate(43));

    for (const removal of removals()) {
      expect(removal).toMatchObject({ joinedAt: expect.any(Number) });
    }
  });

  test("处置与同批 adminsChanged 一起投递，顺序保持 FIFO", async () => {
    // 管理员任免与入群同在一条 chat_member 更新里时，adminsChanged 必须先到。
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleChatMemberUpdate(joinUpdate(42, "administrator"));

    expect(workerPosts.map((message) => message.type)).toEqual(["adminsChanged", "removeBlockedMembers"]);
  });
});
