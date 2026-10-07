/** 「是管理员 && 已初始化」成立那一刻的补扫触发边界。 */

import { describe, expect, spyOn, test } from "bun:test";
import { botPermissions } from "../helpers/botPermissions";
import { settleBackgroundWork } from "../helpers/common";
const {
  blockedUserIds,
  expectLastRemoval,
  getChatMember,
  installBlocklistSweepHooks,
  lastRemovalId,
  persistChatState,
  postDiskIO,
  promotion,
  readBlocklistIdPage,
  remover,
  settleLast,
  settleLastAsForbidden,
  states,
} = await import("../helpers/blocklistSweepHarness");

const {
  hydrateBlocklist,
  registerBlockedMemberRemover,
  trackBlockedRemoval,
} = await import("../../packages/infra/blocklist/outbox");

const {
  quiesceBlocklistSweepScheduler,
  replayPendingBlockedRemovals,
  requestBlocklistResweep,
  settleBlockedRemoval,
  sweepBlockedMembers,
} = await import("../../packages/infra/blocklist/sweep");

const {
  WorkerUndeliveredError,
} = await import("../../packages/libs/workerDelivery");

const { logger } = await import("../../packages/infra/logger");

const {
  BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS,
} = await import("../../packages/consts/antiRaid/blocklist");

const {
  handleMyChatMemberUpdate,
  markBotAdminObserved,
  resolveBotAdminStatus,
} = await import("../../packages/infra/botAdmin");

const {
  blocklistSweepPages,
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

describe("「是管理员 && 已初始化」成立的那一刻触发清扫", () => {
  test("已初始化的群里被任命管理员：投出清扫", async () => {
    states.set(-1001, { isInitEnabled: true });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleMyChatMemberUpdate(promotion("administrator", "member"));

    expectLastRemoval({ chatId: -1001, userIds: [7], probeMembership: true });
  });

  test("扫过一次就不再重复扫：每条更新都重扫会把验证队列压死", async () => {
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    // 管理员权限变更（如加了删消息权）也走 my_chat_member；身份仍是 administrator 也补扫，不只依赖身份值变化边沿。
    await handleMyChatMemberUpdate(promotion("administrator", "administrator"));
    expect(remover).toHaveBeenCalledTimes(1);
    settleLast(true);

    remover.mockClear();
    readBlocklistIdPage.mockClear();
    await handleMyChatMemberUpdate(promotion("administrator", "administrator"));
    expect(remover).not.toHaveBeenCalled();
    // 「不重复扫」在读名单页之前成立：那一次读先向 Disk I/O Worker 请求一次黑名单领域 flush，
    // 再跨线程取一页主键（infra/identityStorage/sweep.ts）；本触发点挂在每条 chat_member 更新的管理员身份观测上。
    expect(readBlocklistIdPage).not.toHaveBeenCalled();
  });

  test("没扫完不算扫过：退避窗口过去后再试一次", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(false);
    remover.mockClear();

    // 触发点是每条入群更新都会来的管理员身份观测：重扫带退避。
    await sweepBlockedMembers(-1001, 2_000);
    expect(remover).not.toHaveBeenCalled();

    await sweepBlockedMembers(-1001, 1_000 + 300_000);
    expect(remover).toHaveBeenCalledTimes(1);
  });

  test("连续没落定就逐次拉长退避：永远封不掉的目标不会每 5 分钟重扫一次整份名单", async () => {
    // 目标自己是这个群的管理员、或机器人是管理员却没有封禁权限时，每一轮补扫都 complete:false；
    // 重扫间隔逐次拉长，不固定为基础间隔。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(false);

    // 第一次退避是 BLOCKLIST_SWEEP_RETRY_INTERVAL_MS。
    await sweepBlockedMembers(-1001, 301_000);
    expect(remover).toHaveBeenCalledTimes(2);
    settleLast(false);

    remover.mockClear();
    // 再过一个基础间隔还不够：这一次的窗口已经翻倍。
    await sweepBlockedMembers(-1001, 601_000);
    expect(remover).not.toHaveBeenCalled();

    await sweepBlockedMembers(-1001, 901_000);
    expect(remover).toHaveBeenCalledTimes(1);
  });

  test("权限不够时停掉按时间的重试，只等一次确证的权限变更", async () => {
    // 退避拉长仍然是「按时间重试」：每个窗口末尾照样重扫整份名单。
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

  test("缺权限标记立即进入 durable outbox 快照，重启恢复后仍是闩锁态", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    await sweepBlockedMembers(-1001, 1_000);
    const removalId: number = lastRemovalId();
    postDiskIO.mockClear();

    settleLastAsForbidden();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    const snapshot = postDiskIO.mock.calls[0]?.[0] as {
      readonly type: string;
      readonly removals: readonly (readonly [number, { readonly lastFailure: string | null }])[];
    };
    expect(snapshot.type).toBe("blocklistRemovals");
    expect(snapshot.removals).toEqual([
      [removalId, expect.objectContaining({ lastFailure: "missing-permission" })],
    ]);

    // 标记没有变化的重复拒绝不再排整份快照。
    settleLastAsForbidden();
    expect(postDiskIO).toHaveBeenCalledTimes(1);

    hydrateBlocklist(new Map(snapshot.removals as never));
    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeTrue();
    remover.mockClear();
    replayPendingBlockedRemovals(false);
    await Bun.sleep(0);
    expect(remover).not.toHaveBeenCalled();
  });

  test("确证拿到封禁权限后立刻解锁并重扫", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
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

  test("投递边界抛错时不得清掉 await 期间刚被并发回执置上的权限闩锁", async () => {
    // 时序：A 群已有一批 frozen 秒踢在途；补扫认领了新的 removalId 并 await durable 投递；
    // 等待期间 Worker 回来一条属于旧批次的 permissionDenied 回执，notePermissionBlocked 置上闩锁后因 removalId 对不上而提前返回；
    // 随后投递边界抛错，失败记账保留 permissionBlocked 为真。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    const frozen = trackBlockedRemoval({ chatId: -1001, userIds: [7], probeMembership: false });

    remover.mockImplementationOnce(async (): Promise<number> => {
      settleBlockedRemoval({
        type: "blockedMembersRemoved",
        participantInvalidUserIds: [],
        settledUserIds: [],
        chatId: -1001,
        removalId: frozen.removalId,
        complete: false,
        permissionDenied: true,
      });
      throw new WorkerUndeliveredError("Anti-Raid Worker is unavailable.");
    });

    await expect(sweepBlockedMembers(-1001, 1_000)).rejects.toThrow();

    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeTrue();
    // 闩锁还在 → 不再按时间重扫，Worker 重生也不重投这批必败任务。
    remover.mockClear();
    await sweepBlockedMembers(-1001, 1_000 + 86_400_000);
    expect(remover).not.toHaveBeenCalled();
    replayPendingBlockedRemovals();
    await Bun.sleep(0);
    expect(remover).not.toHaveBeenCalled();
  });

  test("从没扫过的群也要记下权限受阻，而不是把标记丢掉", async () => {
    // 补扫记录只由 sweepBlockedMembers 创建；机器人从来没有封禁权限的群里，秒踢一路的权限拒绝也要记下标记，
    // replayPendingBlockedRemovals 在 Worker 重生时据此跳过必败处置。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    const params = trackBlockedRemoval({ chatId: -1001, userIds: [7], probeMembership: false });
    expect(blocklistSweepState.has(-1001)).toBeFalse();

    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      participantInvalidUserIds: [],
      settledUserIds: [],
      chatId: -1001,
      removalId: params.removalId,
      complete: false,
      permissionDenied: true,
    });

    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeTrue();
    // 补建的是最小记录：这个群从来没被完整扫过，那一次照旧欠着。
    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
    // 缺权限的指名批次直接销账，不在 outbox 里等权限。
    expect(pendingBlockedRemovals.has(params.removalId)).toBeFalse();
    replayPendingBlockedRemovals();
    await Bun.sleep(0);
    expect(remover).not.toHaveBeenCalled();

    // 解锁边沿照常能打开它，并由一轮当前全名单补扫清出仍在群里的黑名单成员。
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    await handleMyChatMemberUpdate(promotion("administrator", "administrator", true));
    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeFalse();
    expect(remover).toHaveBeenCalledTimes(1);
    expect(remover.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ probeMembership: true }),
    ]);
  });

  test("缺封禁权限的群里反复入群或广告处置不在 outbox 累积，错误日志只在闩锁边沿记一次", () => {
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions({ canRestrictMembers: false }) });
    const errors = spyOn(logger, "error").mockImplementation((): void => undefined);
    try {
      for (let index: number = 0; index < 50; index++) {
        const userId: number = 1_000 + index;
        blockedUserIds.set(userId, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
        const params = trackBlockedRemoval({ chatId: -1001, userIds: [userId], probeMembership: false });
        settleBlockedRemoval({
          type: "blockedMembersRemoved",
          participantInvalidUserIds: [],
          settledUserIds: [],
          chatId: -1001,
          removalId: params.removalId,
          complete: false,
          permissionDenied: true,
        });
      }
      expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeTrue();
      expect(pendingBlockedRemovals.size).toBe(0);
      expect(errors.mock.calls.filter((call: unknown[]): boolean =>
        String(call[0]).includes("missing ban rights"))).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  test("权限恢复时重放同群仍在途的指名批次；缺权限的那批已销账，各批只按自己的 complete 回执销账", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    blockedUserIds.set(8, { isBlocked: true, blockedAt: "2026/07/26 00:00:01" });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
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
      participantInvalidUserIds: [],
      settledUserIds: [],
      chatId: -1001,
      removalId: first.removalId,
      complete: false,
      permissionDenied: true,
    });
    remover.mockClear();

    await handleMyChatMemberUpdate(
      promotion("administrator", "administrator", true)
    );

    expect(pendingBlockedRemovals.has(first.removalId)).toBeFalse();
    expect(remover.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ removalId: second.removalId }),
    ]);
    const sweepRemovalId: number =
      (remover.mock.calls[1]?.[0] as { removalId: number }[])[0]!.removalId;
    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      participantInvalidUserIds: [],
      settledUserIds: [],
      chatId: -1001,
      removalId: sweepRemovalId,
      complete: false,
    });
    expect(pendingBlockedRemovals.has(second.removalId)).toBeTrue();

    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      participantInvalidUserIds: [],
      settledUserIds: [],
      chatId: -1001,
      removalId: second.removalId,
      complete: true,
    });
    expect(pendingBlockedRemovals.has(second.removalId)).toBeFalse();
    expect(pendingBlockedRemovals.has(sweepRemovalId)).toBeTrue();
  });

  test("回归用例：权限恢复时释放补扫 claim，别的批次留下的闩锁不能把这个群永久卡死", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    // 补扫批次 R 已经占住 claim 并投出去。
    await sweepBlockedMembers(-1001, 1_000);
    const sweepRemovalId: number = lastRemovalId();

    // R 还在途时，同群另一批 frozen 秒踢 F 带着「没有封禁权限」回来：闩锁置真，
    // 但 R 的 claim 被原样保留。
    const frozen = trackBlockedRemoval({
      chatId: -1001,
      userIds: [7],
      probeMembership: false,
    });
    settleBlockedRemoval({
      type: "blockedMembersRemoved",
      participantInvalidUserIds: [],
      settledUserIds: [],
      chatId: -1001,
      removalId: frozen.removalId,
      complete: false,
      permissionDenied: true,
    });
    expect(blocklistSweepState.get(-1001)?.removalId).toBe(sweepRemovalId);

    // Anti-Raid Worker 在 R 完成前死掉：被终止的 isolate 发不出回执；闩锁让 Worker 重建时的整批重放跳过这个群。
    remover.mockClear();
    replayPendingBlockedRemovals();
    await Bun.sleep(0);
    expect(remover).not.toHaveBeenCalled();

    // 权限恢复：claim 一并释放；replayPendingBlockedRemovalsForChat 只重放 frozen 批次，
    // prepareBlocklistSweep 在 removalId !== null 时早退。
    await handleMyChatMemberUpdate(promotion("administrator", "administrator", true));
    expect(blocklistSweepState.get(-1001)?.removalId).not.toBe(sweepRemovalId);
    expect(remover.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ probeMembership: true }),
    ]);

    // 后续按时间的重扫不被残留 claim 挡住（这一批没落定，退避窗口过去之后照常再来一轮）。
    settleLast(false);
    remover.mockClear();
    await sweepBlockedMembers(-1001, Date.now() + 10_000_000);
    expectLastRemoval({ chatId: -1001, probeMembership: true });
  });

  test("被权限卡住的群不跟着 Worker 重建重放：那不是权限变更", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLastAsForbidden();
    remover.mockClear();

    replayPendingBlockedRemovals();
    await Bun.sleep(0);
    expect(remover).not.toHaveBeenCalled();
    // 任务本身照常留着，等那次真正的权限观测。
    expect(pendingBlockedRemovals.size).toBe(1);
  });

  test("重启恢复权限闩锁：静态名单仍在也不空转，权限恢复后用新补扫取代旧任务", async () => {
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    blockedUserIds.set(-4004, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(
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
      ])
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
    await Bun.sleep(0);
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

    // 一轮重放会回来多份「没落定」回执；每份都不排全表深拷贝与整文件 fsync（见 replayPendingBlockedRemovals 注释）；
    // 这里变的只有诊断字段，任务本身没有增删。
    for (let attempt: number = 1; attempt < BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS; attempt++) {
      settleBlockedRemoval({ type: "blockedMembersRemoved", participantInvalidUserIds: [], settledUserIds: [], chatId: -1001, removalId, complete: false });
    }
    expect(postDiskIO).not.toHaveBeenCalled();

    // 跨越告警阈值那一次立刻落盘，使「已经失败到该报警了」跨重启存活。
    settleBlockedRemoval({ type: "blockedMembersRemoved", participantInvalidUserIds: [], settledUserIds: [], chatId: -1001, removalId, complete: false });
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(pendingBlockedRemovals.get(removalId)?.attempts).toBe(BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS);
  });

  test("身份从未记录过、又观测到已是管理员：同样算成立的那一刻", async () => {
    // /init enable 会作废身份记录，之后第一次确证（收到别人的 chat_member、
    // 或按需现查）就是合取重新成立的边沿。
    states.set(-1001, { isInitEnabled: true });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await markBotAdminObserved(-1001);

    // 现查按设计不被 await（不能挡住串行的 update 处理），补扫挂在它落地之后。
    await settleBackgroundWork();
    expectLastRemoval({ chatId: -1001, userIds: [7], probeMembership: true });

    // 再观测一次不再扫。
    remover.mockClear();
    await markBotAdminObserved(-1001);
    await settleBackgroundWork();
    expect(remover).not.toHaveBeenCalled();
  });

  test("chat_member 复用缓存快照时不解开缺封禁权限的闩锁，也不重放批次", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    // 快照仍写着能封，Worker 的实际回执却是缺封禁权限。
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions({ canRestrictMembers: true }) });
    await sweepBlockedMembers(-1001, 1_000);
    settleLastAsForbidden();
    expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeTrue();
    remover.mockClear();
    const logs = spyOn(logger, "log");
    try {
      await markBotAdminObserved(-1001);
      await settleBackgroundWork();
      expect(blocklistSweepState.get(-1001)?.permissionBlocked).toBeTrue();
      expect(remover).not.toHaveBeenCalled();
      expect(logs.mock.calls.some((call: unknown[]): boolean => String(call[0]).includes("Ban rights restored"))).toBeFalse();
    } finally {
      logs.mockRestore();
    }
  });

  test("被撤管理员时不清扫：合取由成立变为不成立", async () => {
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleMyChatMemberUpdate(promotion("member", "administrator"));

    expect(remover).not.toHaveBeenCalled();
  });

  test("停管的在途批次先丢弃再落盘：落盘失败也不会把它们留到下次重启", async () => {
    // Telegram 停管更新先清理待处理批次，再向 SQLite chat_states 持久化权限快照；
    // 本次落盘失败也必须保持主线程待处理集合为空，Worker 重建时无旧批次可重投。
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    trackBlockedRemoval({ chatId: -1001, userIds: [7], probeMembership: false });
    expect(pendingBlockedRemovals.size).toBe(1);
    persistChatState.mockRejectedValueOnce(new Error("state store quiesced"));

    await expect(handleMyChatMemberUpdate(promotion("member", "administrator")))
      .rejects.toThrow("state store quiesced");

    expect(pendingBlockedRemovals.size).toBe(0);
  });

  test("状态落盘失败不得被折算成「不是管理员」", async () => {
    // Telegram 侧查到了管理员身份，只是状态没写进硬盘：落盘失败向调用方抛出，不折算成 false。
    states.set(-1001, { isInitEnabled: true });
    persistChatState.mockRejectedValueOnce(new Error("state store quiesced"));

    await expect(resolveBotAdminStatus(-1001)).rejects.toThrow("state store quiesced");
  });

  test("getChatMember 本身失败仍按「不是管理员」兜底，且不落盘", async () => {
    states.set(-1001, { isInitEnabled: true });
    getChatMember.mockRejectedValueOnce(new Error("Bad Request: chat not found"));

    expect(await resolveBotAdminStatus(-1001)).toBeFalse();
    expect(persistChatState).not.toHaveBeenCalled();
    expect(states.get(-1001)?.botPermissions).toBeUndefined();
  });

  test("还没 /init enable 的群不清扫，哪怕这一刻成了管理员", async () => {
    // my_chat_member 绕过 isInitEnabled 网关送达，这里自己把关；合取的另一半由 /init enable 补上，那一刻才轮到清扫。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });

    await handleMyChatMemberUpdate(promotion("administrator", "member"));

    expect(remover).not.toHaveBeenCalled();
  });

  test("秒踢批次没落定：让这个群重新欠一次补扫，而不是只等 Worker 崩溃", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(true);
    expect(blocklistSweepState.get(-1001)?.sweptAt).toEqual(expect.any(Number));

    // 秒踢那一路的批次编号跟补扫进度对不上；黑名单入群不开验证窗口、没有超时踢人兜底。
    const kick = trackBlockedRemoval({ chatId: -1001, userIds: [7], probeMembership: false, joinedAt: 2_000 });
    settleBlockedRemoval({ type: "blockedMembersRemoved", participantInvalidUserIds: [], settledUserIds: [], chatId: -1001, removalId: kick.removalId, complete: false });

    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
  });

  test("/block 封禁失败的群被标回「欠一次」，退避过后重扫", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);
    settleLast(true);
    remover.mockClear();

    // sweptAt 是永久闩锁；/block 封禁失败时用 requestBlocklistResweep 复位它。
    requestBlocklistResweep(-1001, 2_000);
    await sweepBlockedMembers(-1001, 2_000);

    expect(remover).toHaveBeenCalledTimes(1);
  });

  test("在途期间请求的重扫不会被随后的 complete 回执抹掉", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await sweepBlockedMembers(-1001, 1_000);

    // /block 在这个群封禁失败时补扫批次可能还在跑；complete 回执写 sweptAt 时保留这次重扫请求。
    requestBlocklistResweep(-1001, 1_500);
    settleLast(true);

    expect(blocklistSweepState.get(-1001)?.sweptAt).toBeNull();
    remover.mockClear();
    await sweepBlockedMembers(-1001, 2_000);
    expect(remover).toHaveBeenCalledTimes(1);
  });

  test("从没扫过的群显式记下补扫截止时间，不能只等下一条成员事件", () => {
    requestBlocklistResweep(-1001, 2_000);
    expect(blocklistSweepState.get(-1001)).toEqual({
      removalId: null,
      sweptAt: null,
      nextRetryAt: 2_000,
      resweepRequested: false,
      failedSweeps: 0,
      permissionBlocked: false,
    });
  });

  test("先给管理员、后 /init enable：清扫在 enable 那一刻补上", async () => {
    // 最常见的上线顺序。管理员那一跳发生时群还没初始化，扫不了；enable
    // 之后身份记录被作废并重新判定，合取这时才成立。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    await handleMyChatMemberUpdate(promotion("administrator", "member"));
    expect(remover).not.toHaveBeenCalled();

    states.set(-1001, { isInitEnabled: true });
    await markBotAdminObserved(-1001);

    await settleBackgroundWork();
    expectLastRemoval({ chatId: -1001, userIds: [7], probeMembership: true });
  });
});
