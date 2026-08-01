import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { BlockedMemberRemover } from "../../packages/types/blocklist";

const states = new Map<number, Record<string, unknown>>();
const getChatMember = mock(async (): Promise<{ status: string }> => ({ status: "administrator" }));
const persistAuthoritativeState = mock(async (): Promise<void> => {});
/** 处置的执行 owner 替身：主线程侧只该「投出去」，不该自己打 API。 */
const remover = mock(async (..._args: unknown[]): Promise<void> => {});
const postDiskIO = mock((..._args: unknown[]): boolean => true);

mock.module("../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../packages/infra/telegram", () => ({
  bot: { botInfo: { id: 99 }, api: { getChatMember } },
}));
mock.module("../../packages/infra/diskIO", () => ({
  postDiskIO,
  onDiskIORespawn: (): void => {},
  relayLogMessage: (): boolean => true,
  flushDiskIO: async (): Promise<string> => "flushed",
  // /block 只等黑名单这一个领域的落盘回执（见 confirmBlocklistPersisted）。
  flushDiskIODomain: async (): Promise<string> => "flushed",
  lastFailedDiskIODomains: (): readonly string[] => [],
}));
mock.module("../../packages/infra/storage/stateStore", () => ({
  getAllChatStates: (): ReadonlyMap<number, Record<string, unknown>> => states,
  getChatState: (chatId: number): Record<string, unknown> => states.get(chatId) ?? {},
  getOrCreateChatState: (chatId: number): Record<string, unknown> => {
    const current = states.get(chatId) ?? {};
    states.set(chatId, current);
    return current;
  },
  clearChatStateField: (): boolean => false,
  pruneDepartedChatState: (): void => {},
  persistAuthoritativeState,
  saveStateInBackground: (): void => {},
}));
mock.module("../../packages/infra/chatTeardown", () => ({
  teardownRegisteredChat: async (): Promise<void> => {},
  registerChatTeardown: (): void => {},
}));

const {
  forgetChatBlocklistWork,
  hydrateBlocklist,
  registerBlockedMemberRemover,
  trackBlockedRemoval,
} = await import("../../packages/infra/blocklist/outbox");
const {
  replayPendingBlockedRemovals,
  requestBlocklistResweep,
  settleBlockedRemoval,
  sweepManagedBlocklistChats,
  sweepBlockedMembers,
} = await import("../../packages/infra/blocklist/sweep");
const { WorkerUndeliveredError } = await import("../../packages/libs/workerDelivery");
const {
  BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES,
  BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS,
} = await import("../../packages/consts/antiRaid/blocklist");
const { handleMyChatMemberUpdate, resolveBotAdminStatus, markBotAdminObserved } = await import("../../packages/infra/botAdmin");
const {
  blockedMemberRemoverHolder,
  blockedUserIds,
  blocklistSweepState,
  configuredBlockedIds,
  pendingBlockedRemovals,
} = await import("../../packages/cache/main/blocklist");

/** 上一次投出去的那批处置的编号。 */
function lastRemovalId(): number {
  return (remover.mock.calls.at(-1)![0] as readonly { removalId: number }[])[0]!.removalId;
}

function expectLastRemoval(expected: Record<string, unknown>): void {
  expect(remover.mock.calls.at(-1)?.[0]).toEqual([
    expect.objectContaining(expected),
  ]);
}

/** Worker 回执：这批处置全部落定 / 没能落定。 */
function settleLast(complete: boolean, chatId: number = -1001): void {
  settleBlockedRemoval({ type: "blockedMembersRemoved", chatId, removalId: lastRemovalId(), complete });
}

/** 一条机器人自身成员状态变化的 my_chat_member 更新。 */
function promotion(newStatus: string, oldStatus: string, canRestrict?: boolean): never {
  return {
    myChatMember: {
      chat: { id: -1001, type: "supergroup" },
      old_chat_member: { status: oldStatus },
      new_chat_member: {
        status: newStatus,
        ...(canRestrict === undefined ? {} : { can_restrict_members: canRestrict }),
      },
    },
  } as never;
}

/** Worker 回执：这批因为机器人没有封禁权限而没落定。 */
function settleLastAsForbidden(chatId: number = -1001): void {
  settleBlockedRemoval({
    type: "blockedMembersRemoved",
    chatId,
    removalId: lastRemovalId(),
    complete: false,
    permissionDenied: true,
  });
}

beforeEach(() => {
  states.clear();
  blockedUserIds.clear();
  configuredBlockedIds.clear();
  blocklistSweepState.clear();
  pendingBlockedRemovals.clear();
  remover.mockClear();
  postDiskIO.mockClear();
  getChatMember.mockClear();
  persistAuthoritativeState.mockClear();
  postDiskIO.mockImplementation((): boolean => true);
  remover.mockImplementation(async (): Promise<void> => {});
  registerBlockedMemberRemover(remover as unknown as BlockedMemberRemover);
});

describe("黑名单清扫", () => {
  test("启动时只批量补扫已 init 且已确证管理员的群，静态频道走同一名单链路", async () => {
    configuredBlockedIds.add(-4004);
    blockedUserIds.set(7, {
      isBlocked: true,
      blockedAt: "2026/07/26 00:00:00",
    });
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    states.set(-1002, { isInitEnabled: false, botIsAdmin: true });
    states.set(-1003, { isInitEnabled: true, botIsAdmin: false });
    states.set(-1004, { isInitEnabled: true, botIsAdmin: true });

    await sweepManagedBlocklistChats(1_000);

    expect(remover).toHaveBeenCalledTimes(1);
    expect(remover).toHaveBeenCalledWith([
      {
        chatId: -1001,
        userIds: [-4004, 7],
        probeMembership: true,
        removalId: expect.any(Number),
      },
      {
        chatId: -1004,
        userIds: [-4004, 7],
        probeMembership: true,
        removalId: expect.any(Number),
      },
    ]);
    expect(blocklistSweepState.has(-1002)).toBeFalse();
    expect(blocklistSweepState.has(-1003)).toBeFalse();
  });

  test("只取名单快照交给执行 owner，主线程自己不打任何 Telegram API", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    blockedUserIds.set(-4004, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await sweepBlockedMembers(-1001);

    expect(remover).toHaveBeenCalledTimes(1);
    // probeMembership=true：这是名单快照，不确定人在不在群里，Worker 必须
    // 逐个探一次；那 O(名单长度) 次请求不该发生在主线程。
    expect(remover).toHaveBeenCalledWith([{
      chatId: -1001,
      userIds: [7, -4004],
      probeMembership: true,
      removalId: expect.any(Number),
    }]);
    expect(getChatMember).not.toHaveBeenCalled();
    // 回执之前批次一直挂在镜像里：Worker 崩溃时它是唯一的重放依据。
    expect(pendingBlockedRemovals.size).toBe(1);
  });

  test("补扫在 outbox 里不冻结名单：条目不随名单长度增长，投递时才现算", async () => {
    // outbox 每次变更都要整份重写并 fsync，而 N 个群的补扫条目装的是同一份
    // 名单——冻进去就是 O(群数² × 名单长度) 的落盘，`removals.json` 也会成为
    // 整个持久化里唯一一个大小随黑名单长度增长的文件，偏偏它在启动恢复的
    // 关键路径上（见 types/blocklist.ts 的 PendingBlockedRemovalParams）。
    for (let index: number = 0; index < 50; index++) {
      blockedUserIds.set(index + 1, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    }

    await sweepBlockedMembers(-1001);
    await sweepBlockedMembers(-1002);

    // 镜像/落盘的那一份只有任务本身。
    for (const pending of pendingBlockedRemovals.values()) {
      expect(pending.params.probeMembership).toBeTrue();
      expect("userIds" in pending.params).toBeFalse();
    }
    // 投出去的那一份照常带着完整名单。
    const dispatched = remover.mock.calls.at(-1)![0] as { userIds: number[] }[];
    expect(dispatched[0]!.userIds).toHaveLength(50);
  });

  test("补扫投递前现算：登记之后新增的黑名单条目也一起扫", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001);
    const removalId: number = lastRemovalId();

    // 批次还没落定期间又拉黑了一个人：重放时该扫的是**此刻**的名单，而不是
    // 登记那一刻的快照。
    blockedUserIds.set(8, { isBlocked: true, blockedAt: "2026/07/26 00:00:01" });
    remover.mockClear();
    replayPendingBlockedRemovals();

    expect(remover.mock.calls[0]![0]).toEqual([{
      chatId: -1001,
      userIds: [7, 8],
      probeMembership: true,
      removalId,
    }]);
  });

  test("落地回执才销镜像：没落定的批次留着等重投", () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    void sweepBlockedMembers(-1001);
    settleLast(false);
    expect(pendingBlockedRemovals.size).toBe(1);

    settleLast(true);
    expect(pendingBlockedRemovals.size).toBe(0);
  });

  test("Worker 重建后整批重投未销账的处置", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001);
    trackBlockedRemoval({ chatId: -1002, userIds: [8], probeMembership: false });
    remover.mockClear();

    replayPendingBlockedRemovals();

    // 重复 ban 幂等，漏掉却意味着那个人一直坐在群里；重放必须合并成一次
    // write-ahead/flush/barrier，不能按 outbox 条目重复序列化完整快照。
    expect(remover).toHaveBeenCalledTimes(1);
    expect(remover).toHaveBeenCalledWith([
      expect.objectContaining({ chatId: -1001, userIds: [7] }),
      expect.objectContaining({ chatId: -1002, userIds: [8] }),
    ]);
  });

  test("Worker 没收到、屏障失败或落盘失败都保留 durable outbox 任务", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    // 屏障超时/落盘失败：消息已经进了 Worker 信箱，删镜像等于毁掉唯一的重放
    // 依据，那批副作用就永远没人认领了。
    remover.mockRejectedValueOnce(new Error("Anti-Raid Worker barrier timedOut."));
    await expect(sweepBlockedMembers(-1001, 1_000)).rejects.toThrow("barrier timedOut");
    expect(pendingBlockedRemovals.size).toBe(1);

    pendingBlockedRemovals.clear();
    blocklistSweepState.clear();

    // post() 返回 false 时 update 会重投，但 outbox 是独立的跨进程恢复边界，
    // 不能依赖 Telegram 仍保留旧 update 来替代它。
    remover.mockRejectedValueOnce(new WorkerUndeliveredError("Anti-Raid Worker is unavailable."));
    await expect(sweepBlockedMembers(-1001, 1_000)).rejects.toThrow("unavailable");
    expect(pendingBlockedRemovals.size).toBe(1);
  });

  test("回归用例：投递失败也要推进退避——执行 owner 持续抛错时不能每轮都按基础间隔重来", async () => {
    // 这批任务不会再有回执来推进计数（claim 已清空），退避只能由降级路径自己推进。
    // 不推进的话，Worker 不可用期间每次重试都按 BLOCKLIST_SWEEP_RETRY_INTERVAL_MS
    // 排期、永远走不到上限，每一轮还烧掉一个 outbox id 加一行错误日志。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    remover.mockRejectedValue(new WorkerUndeliveredError("Anti-Raid Worker is unavailable."));

    await expect(sweepBlockedMembers(-1001, 1_000)).rejects.toThrow("unavailable");
    expect(blocklistSweepState.get(-1001)?.failedSweeps).toBe(1);
    const firstRetryAt: number = blocklistSweepState.get(-1001)!.nextRetryAt;

    await expect(sweepBlockedMembers(-1001, firstRetryAt)).rejects.toThrow("unavailable");
    expect(blocklistSweepState.get(-1001)?.failedSweeps).toBe(2);
    // 第二轮的等待比第一轮长：这正是退避在增长的证据。
    expect(blocklistSweepState.get(-1001)!.nextRetryAt - firstRetryAt)
      .toBeGreaterThan(firstRetryAt - 1_000);
  });

  test("回归用例：登记不进 outbox 时同样推进退避", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    // 满仓走的是就地降级、不抛出去（抛了会形成重投/重启循环），因此更需要自己
    // 推进退避：没有任何回执会替它做这件事。
    for (let index: number = 0; index < BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES; index++) {
      trackBlockedRemoval({ chatId: -1001, userIds: [index + 1], probeMembership: false });
    }

    await sweepBlockedMembers(-1001, 1_000);

    expect(blocklistSweepState.get(-1001)?.failedSweeps).toBe(1);
    expect(blocklistSweepState.get(-1001)?.removalId).toBeNull();
  });

  test("投递抛错时不踩掉抢先到达的回执", async () => {
    // Worker 收下后同步派发完、主线程还卡在落盘屏障上时，complete 回执会先到。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    remover.mockImplementationOnce(async (...args: unknown[]): Promise<void> => {
      const removals: readonly { removalId: number }[] =
        args[0] as readonly { removalId: number }[];
      settleBlockedRemoval({
        type: "blockedMembersRemoved",
        chatId: -1001,
        removalId: removals[0]!.removalId,
        complete: true,
      });
      throw new Error("Anti-Raid persistence failed.");
    });

    await expect(sweepBlockedMembers(-1001, 1_000)).rejects.toThrow("persistence failed");

    // 回执写下的 sweptAt 不能被 catch 覆盖掉，否则这个群会被反复重扫。
    expect(blocklistSweepState.get(-1001)?.sweptAt).toEqual(expect.any(Number));
  });

  test("同群重试不沉积副本：新一轮补扫取代旧批次", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(false);
    expect(pendingBlockedRemovals.size).toBe(1);

    await sweepBlockedMembers(-1001, 1_000 + 300_000);

    // 名单只增不减，新快照是旧批次的超集；不删就是每个退避窗口沉积一份完整
    // userIds 副本，且每次 Worker 重建全量重投。
    expect(pendingBlockedRemovals.size).toBe(1);
  });

  test("确认没落地达到告警阈值后仍保留 durable 任务", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    const removalId: number = lastRemovalId();

    for (let attempt: number = 1; attempt <= BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS; attempt++) {
      settleBlockedRemoval({ type: "blockedMembersRemoved", chatId: -1001, removalId, complete: false });
      expect(pendingBlockedRemovals.size).toBe(1);
    }
    expect(pendingBlockedRemovals.get(removalId)?.attempts)
      .toBe(BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS);
    expect(pendingBlockedRemovals.get(removalId)?.lastFailure)
      .toBe("side-effect-incomplete");
  });

  test("outbox 达到硬顶后背压新任务，不静默覆盖旧任务", () => {
    for (let index: number = 0; index < BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES; index++) {
      trackBlockedRemoval({
        chatId: -1001,
        userIds: [index + 1],
        probeMembership: false,
      });
    }

    expect(pendingBlockedRemovals.size).toBe(BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES);
    expect((): void => {
      trackBlockedRemoval({ chatId: -1001, userIds: [99_999], probeMembership: false });
    }).toThrow("capacity");
    expect(pendingBlockedRemovals.size).toBe(BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES);
  });

  test("停管连在途批次一起丢弃：重建后不在已放手的群里继续封人", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    expect(pendingBlockedRemovals.size).toBe(1);
    remover.mockClear();

    forgetChatBlocklistWork(-1001);
    replayPendingBlockedRemovals();

    // Worker 侧的处置世代只活在 isolate 里，重建即归零，拦不住重放——停管
    // 必须由主线程权威判定。
    expect(pendingBlockedRemovals.size).toBe(0);
    expect(remover).not.toHaveBeenCalled();
    expect(blocklistSweepState.has(-1001)).toBeFalse();
  });

  test("名单为空时连消息都不投", async () => {
    await sweepBlockedMembers(-1001);
    expect(remover).not.toHaveBeenCalled();
  });

  test("没有注册 owner 时是显式 no-op，不抛错", async () => {
    blockedMemberRemoverHolder.current = (): Promise<void> => Promise.resolve();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await sweepBlockedMembers(-1001);

    expect(remover).not.toHaveBeenCalled();
  });
});

describe("「是管理员 && 已初始化」成立的那一刻触发清扫", () => {
  test("已初始化的群里被任命管理员：投出清扫", async () => {
    states.set(-1001, { isInitEnabled: true });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleMyChatMemberUpdate(promotion("administrator", "member"));

    expectLastRemoval({ chatId: -1001, userIds: [7], probeMembership: true });
  });

  test("扫过一次就不再重复扫：每条更新都重扫会把验证队列压死", async () => {
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    // 管理员权限变更（比如加了删消息权）也走 my_chat_member。第一次仍要补扫
    // ——「早就是管理员」的群此前一次都没扫过，正是把边沿挂在身份变更上时
    // 永远等不到的那一类。
    await handleMyChatMemberUpdate(promotion("administrator", "administrator"));
    expect(remover).toHaveBeenCalledTimes(1);
    settleLast(true);

    remover.mockClear();
    await handleMyChatMemberUpdate(promotion("administrator", "administrator"));
    expect(remover).not.toHaveBeenCalled();
  });

  test("没扫完不算扫过：退避窗口过去后再试一次", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(false);
    remover.mockClear();

    // 触发点是每条入群更新都会来的管理员身份观测：不设退避就是请求风暴。
    await sweepBlockedMembers(-1001, 2_000);
    expect(remover).not.toHaveBeenCalled();

    await sweepBlockedMembers(-1001, 1_000 + 300_000);
    expect(remover).toHaveBeenCalledTimes(1);
  });

  test("连续没落定就逐次拉长退避：永远封不掉的目标不会每 5 分钟重扫一次整份名单", async () => {
    // 目标自己就是这个群的管理员、或机器人是管理员却没有封禁权限时，每一轮
    // 补扫都注定 complete:false。固定 5 分钟一轮的话，这个群会在进程存活期间
    // 永久地每 5 分钟做一次 O(名单长度) 的探测 + 封禁，而它们与验证超时踢人
    // 共用同一条限流队列，正常踢人会被一直顶在后面。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(false);

    // 第一次退避仍是 5 分钟。
    await sweepBlockedMembers(-1001, 301_000);
    expect(remover).toHaveBeenCalledTimes(2);
    settleLast(false);

    remover.mockClear();
    // 再过 5 分钟还不够：这一次的窗口已经涨到 10 分钟。
    await sweepBlockedMembers(-1001, 601_000);
    expect(remover).not.toHaveBeenCalled();

    await sweepBlockedMembers(-1001, 901_000);
    expect(remover).toHaveBeenCalledTimes(1);
  });

  test("权限不够时停掉按时间的重试，只等一次确证的权限变更", async () => {
    // 退避拉长仍然是「按时间重试」：机器人没有封禁权限时，每个窗口末尾照样
    // 要把整份名单重扫一遍，换来的只是同一条报错再刷一次。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    const removalId: number = lastRemovalId();
    settleLastAsForbidden();

    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeTrue();
    // outbox 里留下自解释的标记：运维看到它就知道该去补权限。
    expect(pendingBlockedRemovals.get(removalId)?.lastFailure).toBe("missing-permission");

    remover.mockClear();
    // 时间过去再久也不再重扫。
    await sweepBlockedMembers(-1001, 1_000 + 86_400_000);
    expect(remover).not.toHaveBeenCalled();
    // 「这个群里还留着人」的信号同样不再排新的重扫窗口。
    requestBlocklistResweep(-1001);
    await sweepBlockedMembers(-1001, 1_000 + 86_400_001);
    expect(remover).not.toHaveBeenCalled();
  });

  test("确证拿到封禁权限后立刻解锁并重扫", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    await sweepBlockedMembers(-1001, 1_000);
    settleLastAsForbidden();
    remover.mockClear();

    // 仍然没有封禁权限的观测不解锁：那不是「再试有意义」的边沿。
    await handleMyChatMemberUpdate(promotion("administrator", "administrator", false));
    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeTrue();
    expect(remover).not.toHaveBeenCalled();

    // Telegram 亲口说现在能封人了：解锁并立刻补一次扫。
    await handleMyChatMemberUpdate(promotion("administrator", "administrator", true));
    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeFalse();
    // 旧补扫会被新一轮现时全名单补扫替代；只有冻结的秒踢/广告批次单独重放。
    expect(remover).toHaveBeenCalledTimes(1);
    expect(remover.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ probeMembership: true }),
    ]);
  });

  test("从没扫过的群也要记下权限受阻，而不是把标记丢掉", async () => {
    // 补扫记录只由 sweepBlockedMembers 创建，而机器人从来就没有封禁权限的群
    // 恰恰是最需要这个标记的一类：秒踢那一路的权限拒绝若记不下来，
    // replayPendingBlockedRemovals 每次 Worker 重生都会把这批注定失败的处置
    // 重投一遍，而唯一的解锁边沿没有记录可以解锁。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    const params = trackBlockedRemoval({ chatId: -1001, userIds: [7], probeMembership: false });
    expect(blocklistSweepState.has(-1001)).toBeFalse();

    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      chatId: -1001,
      removalId: params.removalId,
      complete: false,
      permissionDenied: true,
    });

    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeTrue();
    // 补建的是最小记录：这个群从来没被完整扫过，那一次照旧欠着。
    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
    replayPendingBlockedRemovals();
    expect(remover).not.toHaveBeenCalled();

    // 解锁边沿照常能打开它。
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    await handleMyChatMemberUpdate(promotion("administrator", "administrator", true));
    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeFalse();
    // 先重放原 frozen 批次，再补一轮当前全名单；两者各自按 removalId 回执。
    expect(remover).toHaveBeenCalledTimes(2);
    expect(remover.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        removalId: params.removalId,
        probeMembership: false,
      }),
    ]);
    expect(remover.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({ probeMembership: true }),
    ]);
  });

  test("权限恢复重放同群 frozen 批次，各批只按自己的 complete 回执销账", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    blockedUserIds.set(8, { isBlocked: true, blockedAt: "2026/07/26 00:00:01" });
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    const first = trackBlockedRemoval({
      chatId: -1001,
      userIds: [7],
      probeMembership: false,
    });
    const second = trackBlockedRemoval({
      chatId: -1001,
      userIds: [8],
      probeMembership: false,
    });
    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      chatId: -1001,
      removalId: first.removalId,
      complete: false,
      permissionDenied: true,
    });
    remover.mockClear();

    await handleMyChatMemberUpdate(
      promotion("administrator", "administrator", true)
    );

    expect(remover.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ removalId: first.removalId }),
      expect.objectContaining({ removalId: second.removalId }),
    ]);
    const sweepRemovalId: number =
      (remover.mock.calls[1]?.[0] as { removalId: number }[])[0]!.removalId;
    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      chatId: -1001,
      removalId: sweepRemovalId,
      complete: false,
    });
    expect(pendingBlockedRemovals.has(first.removalId)).toBeTrue();
    expect(pendingBlockedRemovals.has(second.removalId)).toBeTrue();

    for (const removalId of [first.removalId, second.removalId]) {
      settleBlockedRemoval({
        type: "blockedMembersRemoved",
        chatId: -1001,
        removalId,
        complete: true,
      });
    }
    expect(pendingBlockedRemovals.has(first.removalId)).toBeFalse();
    expect(pendingBlockedRemovals.has(second.removalId)).toBeFalse();
    expect(pendingBlockedRemovals.has(sweepRemovalId)).toBeTrue();
  });

  test("被权限卡住的群不跟着 Worker 重建重放：那不是权限变更", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLastAsForbidden();
    remover.mockClear();

    replayPendingBlockedRemovals();
    expect(remover).not.toHaveBeenCalled();
    // 任务本身照常留着，等那次真正的权限观测。
    expect(pendingBlockedRemovals.size).toBe(1);
  });

  test("重启恢复权限闩锁：静态名单仍在也不空转，权限恢复后用新补扫取代旧任务", async () => {
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    hydrateBlocklist(
      new Map(),
      new Map([
        [
          21,
          {
            params: {
              chatId: -1001,
              probeMembership: true,
              removalId: 21,
            },
            createdAt: 1_000,
            attempts: 2,
            lastFailure: "missing-permission",
          },
        ],
      ]),
      [-4004]
    );

    expect(blocklistSweepState.get(-1001)).toEqual({
      removalId: null,
      sweptAt: null,
      nextRetryAt: 1_000,
      resweepRequested: false,
      failedSweeps: 2,
      permissionBlocked: true,
    });
    replayPendingBlockedRemovals(false);
    expect(remover).not.toHaveBeenCalled();
    expect(pendingBlockedRemovals.has(21)).toBeTrue();

    await handleMyChatMemberUpdate(
      promotion("administrator", "administrator", true)
    );

    expect(remover).toHaveBeenCalledTimes(1);
    expect(remover.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        chatId: -1001,
        userIds: [-4004],
        probeMembership: true,
      }),
    ]);
    expect(pendingBlockedRemovals.has(21)).toBeFalse();
  });

  test("落定回执把退避清零：权限恢复后立刻回到正常节奏", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(false);
    expect(blocklistSweepState.get(-1001)?.failedSweeps).toBe(1);

    await sweepBlockedMembers(-1001, 301_000);
    settleLast(true);

    expect(blocklistSweepState.get(-1001)?.failedSweeps).toBe(0);
    expect(blocklistSweepState.get(-1001)?.sweptAt).toEqual(expect.any(Number));
  });

  test("没落定的回执不逐条排完整 outbox 快照：那是 O(n²)", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    const removalId: number = lastRemovalId();
    postDiskIO.mockClear();

    // 一轮重放会回来 N 份「没落定」回执；每份都排一次全表深拷贝 + 整文件
    // fsync 的话，合起来就是 replayPendingBlockedRemovals 注释里点名禁止的
    // O(n²)。这里变的只有诊断字段，任务本身没有增删。
    for (let attempt: number = 1; attempt < BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS; attempt++) {
      settleBlockedRemoval({ type: "blockedMembersRemoved", chatId: -1001, removalId, complete: false });
    }
    expect(postDiskIO).not.toHaveBeenCalled();

    // 跨越告警阈值那一次仍要立刻落盘：「已经失败到该报警了」必须跨重启存活。
    settleBlockedRemoval({ type: "blockedMembersRemoved", chatId: -1001, removalId, complete: false });
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(pendingBlockedRemovals.get(removalId)?.attempts).toBe(BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS);
  });

  test("身份从未记录过、又观测到已是管理员：同样算成立的那一刻", async () => {
    // /init enable 会作废身份记录，之后第一次确证（收到别人的 chat_member、
    // 或按需现查）就是合取重新成立的边沿。
    states.set(-1001, { isInitEnabled: true });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await markBotAdminObserved(-1001);

    expectLastRemoval({ chatId: -1001, userIds: [7], probeMembership: true });

    // 再观测一次不再扫。
    remover.mockClear();
    await markBotAdminObserved(-1001);
    expect(remover).not.toHaveBeenCalled();
  });

  test("被撤管理员时不清扫：合取由成立变为不成立", async () => {
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleMyChatMemberUpdate(promotion("member", "administrator"));

    expect(remover).not.toHaveBeenCalled();
  });

  test("停管的在途批次先丢弃再落盘：落盘失败也不会把它们留到下次重启", async () => {
    // 停管是 Telegram 已经告知的权威事实，不会因为 state.json 没写成而撤销。
    // 清理排在落盘之后的话，persistAuthoritativeState 一拒绝这行就不执行、
    // 进程随即退出，而 state.json 里 botIsAdmin 还是 true——启动恢复那道
    // `botIsAdmin !== true` 过滤同样兜不住，这批注定失败的处置会在每次重启和
    // 每次 Worker 重建时原样重投。
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    trackBlockedRemoval({ chatId: -1001, userIds: [7], probeMembership: false });
    expect(pendingBlockedRemovals.size).toBe(1);
    persistAuthoritativeState.mockRejectedValueOnce(new Error("state store quiesced"));

    await expect(handleMyChatMemberUpdate(promotion("member", "administrator")))
      .rejects.toThrow("state store quiesced");

    expect(pendingBlockedRemovals.size).toBe(0);
  });

  test("状态落盘失败不得被折算成「不是管理员」", async () => {
    // Telegram 侧明明查到了管理员身份，只是状态没写进硬盘。折算成 false 的话，
    // 调用方按非管理员早退：这一批 new_chat_members 不开验证窗口、不被消息
    // 跟踪、超时也不踢，一整批刷群就这么走进来，而唯一的诊断把锅指向 Telegram
    // API，下一次调用又从内存读到 true，现象根本复现不了。
    states.set(-1001, { isInitEnabled: true });
    persistAuthoritativeState.mockRejectedValueOnce(new Error("state store quiesced"));

    await expect(resolveBotAdminStatus(-1001)).rejects.toThrow("state store quiesced");
  });

  test("getChatMember 本身失败仍按「不是管理员」兜底，且不落盘", async () => {
    states.set(-1001, { isInitEnabled: true });
    getChatMember.mockRejectedValueOnce(new Error("Bad Request: chat not found"));

    expect(await resolveBotAdminStatus(-1001)).toBeFalse();
    expect(persistAuthoritativeState).not.toHaveBeenCalled();
    expect(states.get(-1001)?.botIsAdmin).toBeUndefined();
  });

  test("还没 /init enable 的群不清扫，哪怕这一刻成了管理员", async () => {
    // my_chat_member 会绕过 isInitEnabled 网关送达，这里必须自己把关，
    // 否则机器人一被拉进任何群当管理员就会在别人群里踢人。合取的另一半
    // 之后由 /init enable 补上，那一刻才轮到清扫。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleMyChatMemberUpdate(promotion("administrator", "member"));

    expect(remover).not.toHaveBeenCalled();
  });

  test("秒踢批次没落定：让这个群重新欠一次补扫，而不是只等 Worker 崩溃", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(true);
    expect(blocklistSweepState.get(-1001)?.sweptAt).toEqual(expect.any(Number));

    // 秒踢那一路的批次编号跟补扫进度对不上；黑名单入群不开验证窗口、没有超时
    // 踢人兜底，这批失败就是那个人留在群里的全部原因。
    const kick = trackBlockedRemoval({ chatId: -1001, userIds: [7], probeMembership: false, joinedAt: 2_000 });
    settleBlockedRemoval({ type: "blockedMembersRemoved", chatId: -1001, removalId: kick.removalId, complete: false });

    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
  });

  test("/block 封禁失败的群被标回「欠一次」，退避过后重扫", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(true);
    remover.mockClear();

    // sweptAt 是永久闩锁，唯一的复位路径本来只有停管：那个群里被拉黑的人会
    // 一直待到进程结束。
    requestBlocklistResweep(-1001, 2_000);
    await sweepBlockedMembers(-1001, 2_000);

    expect(remover).toHaveBeenCalledTimes(1);
  });

  test("在途期间请求的重扫不会被随后的 complete 回执抹掉", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);

    // /block 在这个群封禁失败时，补扫批次可能还在跑。回执若照常写 sweptAt，
    // 这次请求就丢了——而它正是冲着「这个群里还留着人」来的。
    requestBlocklistResweep(-1001, 1_500);
    settleLast(true);

    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
    remover.mockClear();
    await sweepBlockedMembers(-1001, 2_000);
    expect(remover).toHaveBeenCalledTimes(1);
  });

  test("从没扫过的群不必记账：本来就欠着一次", () => {
    requestBlocklistResweep(-1001, 2_000);
    expect(blocklistSweepState.has(-1001)).toBeFalse();
  });

  test("先给管理员、后 /init enable：清扫在 enable 那一刻补上", async () => {
    // 最常见的上线顺序。管理员那一跳发生时群还没初始化，扫不了；enable
    // 之后身份记录被作废并重新判定，合取这时才成立。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await handleMyChatMemberUpdate(promotion("administrator", "member"));
    expect(remover).not.toHaveBeenCalled();

    states.set(-1001, { isInitEnabled: true });
    await markBotAdminObserved(-1001);

    expectLastRemoval({ chatId: -1001, userIds: [7], probeMembership: true });
  });
});
