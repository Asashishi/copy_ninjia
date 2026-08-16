import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AntiRaidWorkerMessage } from "../../../packages/types";
import type { DiskBusinessMessage } from "../../../packages/types/diskIO";
import {
  blockedIdentityTestView as blockedUserIds,
  readBlockedIdentityTestIds,
} from "../../helpers/identityStorage";

const workerPosts: AntiRaidWorkerMessage[] = [];
/** 被要求补齐权限位的群，验证刷屏投递顺手触发了那次按需现查。 */
const ensuredPermissionChats: number[] = [];
/** 在主线程入口被黑名单频道守卫删除的已知消息。 */
const deletedMessages: { chatId: number; messageId: number }[] = [];
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
  // 入群守卫开着：本文件考察的是守卫开启时黑名单如何取代验证投递（关着时
  // 的行为由 test/antiRaid/joinGuardSwitch.test.ts 覆盖）。
  getChatState: () => ({ isFloodControlEnabled: true, isAntiRaidEnabled: true }),
  getChatStateCache: () => new Map(),
  getOrCreateChatState: () => ({}),
  persistChatState: async (): Promise<void> => {},
  flushStateToDisk: async (): Promise<string> => "flushed",
  saveChatStateInBackground: (): void => {},
}));
mock.module("../../../packages/infra/telegram/actions", () => ({
  answerCallbackQuery: async (): Promise<boolean> => true,
  // 广告处置的群内播报用的，本文件不触发；整份模块被替换掉时缺了它们会在
  // import 阶段就报 Export not found。
  sendMessage: async (): Promise<number | undefined> => undefined,
  deleteMessageAfter: (): void => {},
  deleteMessageWithOutcome: async (
    chatId: number,
    messageId: number
  ): Promise<"deleted"> => {
    deletedMessages.push({ chatId, messageId });
    return "deleted";
  },
}));
mock.module("../../../packages/infra/telegram/client", () => ({
  installTelegramApi: (): void => {},
  joinVerificationApi: { kind: "guard-api" },
}));
mock.module("../../../packages/infra/botAdmin", () => ({
  resolveBotAdminStatus: async (): Promise<boolean> => true,
  markBotAdminObserved: async (): Promise<void> => {},
  botChatPermissionsIn: async (): Promise<undefined> => undefined,
  registerBotPermissionObserver: (): void => {},
  ensureBotChatPermissions: (chatId: number): void => { ensuredPermissionChats.push(chatId); },
  botCanDeleteMessagesIn: (): true => true,
}));
mock.module("../../../packages/infra/supervisedWorker", () => ({
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
  // 落盘 Worker 正常可写：这些用例考察的是 flush 结果本身，不是恢复握手期。
  isDiskIOBuffering: (): boolean => false,
  flushDiskIODomainOutcome: async (): Promise<{ result: string }> => ({ result: await flushDiskIODomain() }),
  onDiskIORespawn: (): void => {},
  onIdentityStoragePersisted: (): void => {},
  readBlocklistIds: async (): Promise<readonly number[]> => readBlockedIdentityTestIds(),
  onVerificationPersisted: (): void => {},
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
const { handleChatMemberUpdate, handleAntiRaidMessageIngress } = await import("../../../packages/antiRaid");
const { pendingBlockedRemovals } = await import("../../../packages/cache/main/blocklist");
const { recentBlockedJoinCounts } = await import("../../../packages/cache/main/antiRaid/blocklistGuard");
const { chatIsSupergroupById } = await import("../../../packages/cache/main/antiRaid/chatKind");
const { unblockUser } = await import("../../../packages/infra/blocklist/membership");

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
  ensuredPermissionChats.length = 0;
  deletedMessages.length = 0;
  diskPosts.length = 0;
  deliveryOrder.length = 0;
  flushDiskIODomain.mockClear();
  flushDiskIODomain.mockImplementation(async (): Promise<string> => {
    deliveryOrder.push("disk-flush");
    return "flushed";
  });
  blockedUserIds.clear();
  pendingBlockedRemovals.clear();
  recentBlockedJoinCounts.clear();
  // 群类型镜像按值去重、每个群一生只投一次：不清就变成「哪个用例先跑哪个能
  // 看到那条投递」，随机顺序下必然翻车。
  chatIsSupergroupById.clear();
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
    expect(diskPosts).toContainEqual({
      type: "joinLog",
      chatId: -1001,
      userId: 42,
      joinedAt: 1_000,
      day: "1970-01-01",
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
    expect(deliveryOrder).toEqual([
      // 群类型镜像排在最前：它是踢人方法分派的依据，必须先于任何可能触发踢人
      // 的投递到达 Worker（见 antiRaid/chatKind.ts）。按值去重，每个群只投一次。
      "worker-chatKind",
      "disk-joinLog",
      "disk-flush",
      "disk-blocklistRemovals",
      "disk-flush",
      "worker-removeBlockedMembers",
    ]);
  });

  test("管理员身份也救不了：黑名单优先于一切入群豁免", async () => {
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleChatMemberUpdate(joinUpdate(42, "administrator"));

    expect(removals()).toHaveLength(1);
    expect(joins()).toHaveLength(0);
  });

  test("outbox 未落盘时不把处置投给 Worker，也不确认这条 update", async () => {
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    flushDiskIODomain.mockResolvedValueOnce("flushed");
    flushDiskIODomain.mockResolvedValueOnce("failed");

    await expect(handleChatMemberUpdate(joinUpdate(42))).rejects.toThrow(
      "Blocklist removal outbox flush failed"
    );

    expect(removals()).toHaveLength(0);
    expect(pendingBlockedRemovals.size).toBe(1);
    expect(diskPosts.at(-1)?.type).toBe("blocklistRemovals");
  });

  test("入群日志未落盘时不继续投递验证或黑名单处置", async () => {
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    flushDiskIODomain.mockResolvedValueOnce("failed");

    await expect(handleChatMemberUpdate(joinUpdate(42))).rejects.toThrow(
      "Persistence Worker rejected join log event"
    );

    expect(removals()).toHaveLength(0);
    expect(joins()).toHaveLength(0);
    expect(pendingBlockedRemovals).toHaveLength(0);
    expect(diskPosts).toEqual([{
      type: "joinLog",
      chatId: -1001,
      userId: 42,
      joinedAt: 1_000,
      day: "1970-01-01",
    }]);
  });

  test("outbox flush 等待期间解除拉黑时，先持久化取消且不投递旧处置", async () => {
    blockedUserIds.set(42, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    let releaseOutboxFlush: ((result: string) => void) | undefined;
    flushDiskIODomain.mockResolvedValueOnce("flushed");
    flushDiskIODomain.mockImplementationOnce(
      (): Promise<string> => new Promise<string>((resolve: (result: string) => void): void => {
        releaseOutboxFlush = resolve;
      })
    );

    const handling: Promise<void> = handleChatMemberUpdate(joinUpdate(42));
    // 先跨过 joinLog durable flush，再等 write-ahead snapshot 的领域 flush 真正
    // 挂起，才模拟并发到达的 /unblock。
    for (
      let turn: number = 0;
      turn < 20 && flushDiskIODomain.mock.calls.length < 2;
      turn++
    ) {
      await Bun.sleep(0);
    }
    expect(flushDiskIODomain).toHaveBeenCalledTimes(2);
    expect(unblockUser(42)).toBeTrue();
    if (releaseOutboxFlush === undefined) {
      throw new Error("Expected the outbox flush to be pending.");
    }
    releaseOutboxFlush("flushed");

    await handling;

    expect(removals()).toHaveLength(0);
    expect(pendingBlockedRemovals.size).toBe(0);
    // 发现权威任务已取消后还要再 flush 一次空快照，不能只依赖 /unblock
    // 排队但尚未确认的 cleanup。
    expect(flushDiskIODomain).toHaveBeenCalledTimes(3);
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

    const claimed: boolean = await handleAntiRaidMessageIngress({
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
    await handleAntiRaidMessageIngress({
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

    // 群类型镜像是每个群一次的旁路，与这条 FIFO 约束无关（它的位置由上面那条
    // deliveryOrder 用例单独钉住）；这里只看这两条的先后。
    expect(
      workerPosts
        .map((message) => message.type)
        .filter((type) => type !== "chatKind")
    ).toEqual(["adminsChanged", "removeBlockedMembers"]);
  });
});

describe("黑名单频道消息入口", () => {
  test("广告未启用时仍先删除当前已知消息，并阻止其进入后续流水线", async () => {
    blockedUserIds.set(-1009, {
      isBlocked: true,
      blockedAt: "2026/07/26 00:00:00",
    });

    const claimed: boolean = await handleAntiRaidMessageIngress({
      message_id: 16,
      date: 1,
      chat: { id: -1001, type: "supergroup" },
      sender_chat: { id: -1009, type: "channel", title: "Blocked Channel" },
      text: "blocked payload",
    } as never, 999);

    expect(claimed).toBeTrue();
    expect(deletedMessages).toEqual([{ chatId: -1001, messageId: 16 }]);
    // 群类型镜像与本条消息的处置无关，是每个群一次的旁路；这里断言的是「没有
    // 任何入群守卫工作被投出去」。
    expect(workerPosts.filter((message) => message.type !== "chatKind")).toBeEmpty();
  });
});

/** 本次投给 Worker 的刷屏计数消息。 */
function floodCandidates(): AntiRaidWorkerMessage[] {
  return workerPosts.filter((message) => message.type === "floodCandidate");
}

describe("刷屏计数的主线程投递接线", () => {
  test("普通超级群消息收敛成一条 floodCandidate，并顺手补齐该群权限位", async () => {
    await handleAntiRaidMessageIngress({
      message_id: 11,
      date: 1,
      chat: { id: -1001, type: "supergroup" },
      from: { id: 7, is_bot: false, first_name: "刷屏怪", username: "noisy" },
      text: "spam",
    } as never, 999);

    expect(floodCandidates()).toEqual([
      { type: "floodCandidate", chatId: -1001, userId: 7, label: "@noisy" },
    ]);
    // Worker 侧的禁言闸只认镜像过去的权限，而 my_chat_member 未必在本进程
    // 生命周期内到过这个群。
    expect(ensuredPermissionChats).toEqual([-1001]);
  });

  test("入群公告不是谁的「发言」，不进任何人的窗口", async () => {
    await handleAntiRaidMessageIngress({
      message_id: 12,
      date: 1,
      chat: { id: -1001, type: "supergroup" },
      from: { id: 5, is_bot: false, first_name: "Inviter" },
      new_chat_members: [{ id: 43, is_bot: false, first_name: "Normal" }],
    } as never, 999);

    expect(floodCandidates()).toBeEmpty();
    expect(ensuredPermissionChats).toBeEmpty();
  });

  test("离群公告同理不计数", async () => {
    await handleAntiRaidMessageIngress({
      message_id: 13,
      date: 1,
      chat: { id: -1001, type: "supergroup" },
      from: { id: 5, is_bot: false, first_name: "Inviter" },
      left_chat_member: { id: 43, is_bot: false, first_name: "Normal" },
    } as never, 999);

    expect(floodCandidates()).toBeEmpty();
  });

  test("机器人自己与频道马甲不投递", async () => {
    await handleAntiRaidMessageIngress({
      message_id: 14,
      date: 1,
      chat: { id: -1001, type: "supergroup" },
      from: { id: 999, is_bot: true, first_name: "本天才" },
      text: "spam",
    } as never, 999);
    await handleAntiRaidMessageIngress({
      message_id: 15,
      date: 1,
      chat: { id: -1001, type: "supergroup" },
      from: { id: 7, is_bot: false, first_name: "刷屏怪" },
      sender_chat: { id: -1009, type: "channel", title: "马甲" },
      text: "spam",
    } as never, 999);

    expect(floodCandidates()).toBeEmpty();
  });
});
