/** 黑名单补扫的退避、claim、回执结算与 outbox 交互。 */

import { describe, expect, test } from "bun:test";
import { botPermissions } from "../helpers/botPermissions";
import { settleBackgroundWork } from "../libs/helpers";
const {
  blockedUserIds,
  configuredBlockedIds,
  expectLastRemoval,
  getChatMember,
  installBlocklistSweepHooks,
  lastRemovalId,
  readBlocklistIdPage,
  remover,
  setBlocklistIdReads,
  settleLast,
  states,
} = await import("../helpers/blocklistSweepHarness");

const {
  forgetChatBlocklistWork,
  registerBlockedMemberRemover,
  trackBlockedRemoval,
} = await import("../../packages/infra/blocklist/outbox");

const {
  initBlocklistSweepScheduler,
  quiesceBlocklistSweepScheduler,
  replayPendingBlockedRemovals,
  requestBlocklistResweep,
  settleBlockedRemoval,
  sweepBlockedMembers,
  sweepManagedBlocklistChats,
} = await import("../../packages/infra/blocklist/sweep");

const {
  WorkerUndeliveredError,
} = await import("../../packages/libs/workerDelivery");

const {
  BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES,
  BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS,
} = await import("../../packages/consts/antiRaid/blocklist");
const {
  BLOCKLIST_SWEEP_PAGE_SIZE,
} = await import("../../packages/consts/identityStorage");

const {
  blockedMemberRemoverHolder,
  blocklistSweepPages,
  blocklistSweepSchedulerState,
  blocklistSweepState,
  pendingBlockedRemovals,
} = await import("../../packages/cache/main/blocklist");

installBlocklistSweepHooks({
  quiesceBlocklistSweepScheduler,
  registerBlockedMemberRemover,
  settleBlockedRemoval,
  blocklistSweepPages,
  blocklistSweepState,
  pendingBlockedRemovals,
});

describe("黑名单清扫", () => {
  test("补扫截止时间由唯一 timer 主动唤醒，不依赖后续成员事件", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    initBlocklistSweepScheduler();
    requestBlocklistResweep(-1001, Date.now() + 5);

    await Bun.sleep(20);

    expect(remover).toHaveBeenCalledTimes(1);
    expectLastRemoval({ chatId: -1001, userIds: [7], probeMembership: true });
    quiesceBlocklistSweepScheduler();
  });

  test("停机 quiesce 取消补扫 timer，durable 状态留给下次启动", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    initBlocklistSweepScheduler();
    requestBlocklistResweep(-1001, Date.now() + 10);

    quiesceBlocklistSweepScheduler();
    await Bun.sleep(20);

    expect(remover).not.toHaveBeenCalled();
    expect(blocklistSweepSchedulerState.timer).toBeNull();
    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
  });

  test("启动时只批量补扫已 init 且已确证管理员的群，静态频道走同一名单链路", async () => {
    configuredBlockedIds.add(-4004);
    blockedUserIds.set(7, {
      isBlocked: true,
      blockedAt: "2026/07/26 00:00:00",
    });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    states.set(-1002, { isInitEnabled: false, botPermissions: botPermissions() });
    states.set(-1003, {
      isInitEnabled: true,
      botPermissions: botPermissions({ isAdministrator: false, canManageChat: false }),
    });
    states.set(-1004, { isInitEnabled: true, botPermissions: botPermissions() });

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
      userIds: [-4004, 7],
      probeMembership: true,
      removalId: expect.any(Number),
    }]);
    expect(getChatMember).not.toHaveBeenCalled();
    // 回执之前批次一直挂在镜像里：Worker 崩溃时它是唯一的重放依据。
    expect(pendingBlockedRemovals.size).toBe(1);
  });

  test("补扫严格按固定页投递，上一页回执前不读取或排队下一页", async () => {
    for (let id: number = 1; id <= BLOCKLIST_SWEEP_PAGE_SIZE + 2; id++) {
      blockedUserIds.set(id, {
        isBlocked: true,
        blockedAt: "2026/08/17 00:00:00",
      });
    }

    await sweepBlockedMembers(-1001, 1_000);

    expect(readBlocklistIdPage).toHaveBeenCalledTimes(1);
    expect(readBlocklistIdPage).toHaveBeenLastCalledWith(null);
    expect(remover).toHaveBeenCalledTimes(1);
    const firstPage = remover.mock.calls[0]![0] as {
      chatId: number;
      probeMembership: boolean;
      removalId: number;
      userIds: number[];
    }[];
    expect(firstPage[0]!.userIds).toHaveLength(BLOCKLIST_SWEEP_PAGE_SIZE);
    const removalId: number = firstPage[0]!.removalId;
    expect(blocklistSweepPages.size).toBe(1);
    expect(pendingBlockedRemovals.size).toBe(1);

    // 一页只有落地回执后才允许续读；不能一次把剩余页全塞进 Worker mailbox。
    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      chatId: -1001,
      removalId,
      complete: true,
      permissionDenied: false,
      targetIsAdmin: false,
    });
    // 下一页 flush/read 尚未完成时，上一页的重复回执不能把 durable 任务提前销账。
    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      chatId: -1001,
      removalId,
      complete: true,
      permissionDenied: false,
      targetIsAdmin: false,
    });
    expect(pendingBlockedRemovals.size).toBe(1);
    await settleBackgroundWork();

    expect(readBlocklistIdPage).toHaveBeenCalledTimes(2);
    expect(readBlocklistIdPage).toHaveBeenLastCalledWith(
      BLOCKLIST_SWEEP_PAGE_SIZE
    );
    expect(remover).toHaveBeenCalledTimes(2);
    const finalPage = remover.mock.calls[1]![0] as {
      chatId: number;
      probeMembership: boolean;
      removalId: number;
      userIds: number[];
    }[];
    expect(finalPage).toEqual([{
      chatId: -1001,
      probeMembership: true,
      removalId,
      userIds: [BLOCKLIST_SWEEP_PAGE_SIZE + 1, BLOCKLIST_SWEEP_PAGE_SIZE + 2],
    }]);
    // 多页共用一条 durable 任务；中间页回执不得提前销账。
    expect(pendingBlockedRemovals.size).toBe(1);

    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      chatId: -1001,
      removalId,
      complete: true,
      permissionDenied: false,
      targetIsAdmin: false,
    });
    expect(pendingBlockedRemovals.size).toBe(0);
    expect(blocklistSweepPages.size).toBe(0);
  });

  test("续页读取失败释放 claim 并推进退避，outbox 留给下一轮从头重放", async () => {
    for (let id: number = 1; id <= BLOCKLIST_SWEEP_PAGE_SIZE + 1; id++) {
      blockedUserIds.set(id, {
        isBlocked: true,
        blockedAt: "2026/08/17 00:00:00",
      });
    }
    let reads: number = 0;
    setBlocklistIdReads((): Promise<readonly number[]> => {
      reads++;
      if (reads === 1) return Promise.resolve([...blockedUserIds.keys()]);
      return Promise.reject(new Error("cursor page unavailable"));
    });

    await sweepBlockedMembers(-1001, 1_000);
    const removalId: number = lastRemovalId();
    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      chatId: -1001,
      removalId,
      complete: true,
      permissionDenied: false,
      targetIsAdmin: false,
    });
    await settleBackgroundWork();

    expect(pendingBlockedRemovals.has(removalId)).toBeTrue();
    expect(blocklistSweepPages.has(removalId)).toBeFalse();
    expect(blocklistSweepState.get(-1001)?.removalId).toBeNull();
    expect(blocklistSweepState.get(-1001)?.failedSweeps).toBe(1);
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
    // 投出去的那一份只带当前有界页。
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
    await Bun.sleep(0);

    expect(remover.mock.calls[0]![0]).toEqual([{
      chatId: -1001,
      userIds: [7, 8],
      probeMembership: true,
      removalId,
    }]);
  });

  test("落地回执才销镜像：没落定的批次留着等重投", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await sweepBlockedMembers(-1001);
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
    await Bun.sleep(0);

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

  test("回归用例：Worker 重建重投的 durable 交接失败时让这些群重新欠一次补扫", async () => {
    // 这次重投是 fire-and-forget 的，rejection 到达时 onRespawn 早已返回，够不着
    // supervisedWorker 的 replayFailure。只记一行日志就等于放弃：frozen 批次
    // （`/block` 秒踢）既没有计时器也没有退避，重试钩子只有「下一次 Worker 重建」
    // 和「一次确证的权限恢复」，两者都不来时那批人就一直坐在群里。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001);
    settleLast(true);
    // 补扫已经落定：闩锁打开、sweptAt 有值，此刻这个群不欠补扫。
    expect(blocklistSweepState.get(-1001)?.sweptAt).not.toBeNull();
    trackBlockedRemoval({ chatId: -1001, userIds: [7], probeMembership: false });

    remover.mockRejectedValueOnce(new Error("Anti-Raid Worker barrier timedOut."));
    replayPendingBlockedRemovals();
    await Bun.sleep(0);

    // 丢掉的 frozen 批次由整份黑名单的补扫覆盖（口径同 settleBlockedRemoval 对
    // 未落定回执的处理），outbox 条目本身照旧留着等下一次重投。
    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
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
    remover.mockImplementationOnce(async (...args: unknown[]): Promise<number> => {
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
    await Bun.sleep(0);

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
    blockedMemberRemoverHolder.current = (): Promise<number> => Promise.resolve(0);
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await sweepBlockedMembers(-1001);

    expect(remover).not.toHaveBeenCalled();
    // 一条都没投出去 = claim 必须作废：留着的话这个群此后永远在
    // prepareBlocklistSweep 的 `removalId !== null` 早退，再也不会被清扫。
    expect(blocklistSweepState.get(-1001)?.removalId).toBeNull();
  });

  test("正常 resolve 但零投递按失败结算：作废 claim 并推进退避", async () => {
    // durable 对账在并发 /unblock 反复裁剪同一批时会扣下整批 removeBlockedMembers，
    // 投递路径于是拿着空数组早退并正常 resolve——没抛错，也没有任何消息在途。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    remover.mockImplementationOnce(async (): Promise<number> => 0);

    await sweepBlockedMembers(-1001, 1_000);

    expect(remover).toHaveBeenCalledTimes(1);
    // claim 作废、退避推进：不这么记的话 removalId 停在原值，而回执永不会来。
    expect(blocklistSweepState.get(-1001)?.removalId).toBeNull();
    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
    expect(blocklistSweepState.get(-1001)?.failedSweeps).toBe(1);
    // durable 任务留在 outbox 里，等下一轮补扫或 Worker 重建重放。
    expect(pendingBlockedRemovals.size).toBe(1);
    expect(pendingBlockedRemovals.values().next().value?.lastFailure).toBe("delivery-boundary");

    // 退避到点后可以重新认领：真正卡死的判据是这一步能不能再投出去。
    remover.mockClear();
    await sweepBlockedMembers(-1001, 1_000 + 300_000);
    expect(remover).toHaveBeenCalledTimes(1);
  });
});
