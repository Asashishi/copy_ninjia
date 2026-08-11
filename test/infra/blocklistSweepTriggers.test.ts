/** 「是管理员 && 已初始化」成立那一刻的补扫触发边界。 */

import { describe, expect, test } from "bun:test";
const {
  blockedUserIds,
  expectLastRemoval,
  getChatMember,
  installBlocklistSweepHooks,
  lastRemovalId,
  persistAuthoritativeState,
  postDiskIO,
  promotion,
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

const {
  BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS,
} = await import("../../packages/consts/antiRaid/blocklist");

const {
  handleMyChatMemberUpdate,
  markBotAdminObserved,
  resolveBotAdminStatus,
} = await import("../../packages/infra/botAdmin");

const {
  blocklistSweepState,
  pendingBlockedRemovals,
} = await import("../../packages/cache/main/blocklist");

installBlocklistSweepHooks({
  quiesceBlocklistSweepScheduler,
  registerBlockedMemberRemover,
  settleBlockedRemoval,
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
    // 永久地每 5 分钟做一次 O(名单长度) 的探测 + 封禁；这些封禁与验证超时踢人
    // 共用 kick 类别的 429 FIFO，类别正在退避时会持续扩大安全动作积压。
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

  test("投递边界抛错时不得清掉 await 期间刚被并发回执置上的权限闩锁", async () => {
    // 时序：A 群已有一批 frozen 秒踢在途；补扫认领了新的 removalId 并 await
    // durable 投递；等待期间 Worker 回来一条属于**旧批次**的 permissionDenied
    // 回执——notePermissionBlocked 置上闩锁后，因 removalId 对不上而提前返回，
    // 闩锁是它留下的唯一痕迹。随后投递边界抛错，失败记账若原样写
    // permissionBlocked: false，就把它抹掉了：此后每一次管理员身份观测都会
    // 重新武装一整轮注定 400 的全名单补扫，持续浪费 Worker 调度、网络与日志。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    const frozen = trackBlockedRemoval({ chatId: -1001, userIds: [7], probeMembership: false });

    remover.mockImplementationOnce(async (): Promise<number> => {
      settleBlockedRemoval({
        type: "blockedMembersRemoved",
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
    await Bun.sleep(0);
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

  test("回归用例：权限恢复时释放补扫 claim，别的批次留下的闩锁不能把这个群永久卡死", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
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
      chatId: -1001,
      removalId: frozen.removalId,
      complete: false,
      permissionDenied: true,
    });
    expect(blocklistSweepState.get(-1001)?.removalId).toBe(sweepRemovalId);

    // Anti-Raid Worker 在 R 完成前死掉：被终止的 isolate 什么回执都发不出来，
    // 而闩锁又让 Worker 重建时的整批重放跳过这个群，R 从此没人重投。
    remover.mockClear();
    replayPendingBlockedRemovals();
    await Bun.sleep(0);
    expect(remover).not.toHaveBeenCalled();

    // 权限恢复：claim 必须一并释放。继续沿用 R 的话，
    // replayPendingBlockedRemovalsForChat 按设计只重放 frozen 批次、不会重投 R，
    // 而 prepareBlocklistSweep 又因为 removalId !== null 永久早退——这个群从此
    // 再也补扫不了，黑名单成员就一直坐在里面。
    await handleMyChatMemberUpdate(promotion("administrator", "administrator", true));
    expect(blocklistSweepState.get(-1001)?.removalId).not.toBe(sweepRemovalId);
    expect(remover.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ probeMembership: true }),
    ]);

    // 后续按时间的重扫同样不再被幽灵 claim 挡住（这一批没落定，退避窗口过去
    // 之后照常再来一轮）。
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
    states.set(-1001, { isInitEnabled: true, botIsAdmin: true });
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

    expectLastRemoval({ chatId: -1001, userIds: [7], probeMembership: true });
  });
});
