/**
 * 黑名单 outbox owner 的丢弃与销账分支。
 *
 * 这些路径都会**去掉已经登记的待踢任务**并重写落盘快照：启动恢复时群不再受管、
 * 机器人不再是管理员、补扫名单已空；运行期 /unblock 摘掉最后一个目标、群被停止
 * 管理。出错时表现为「有人被 /block 了却一直留在群里」或「解封后仍被踢」，而且
 * 没有任何日志会点名是哪一步丢的，因此必须逐条钉死。
 */

import { describe, expect, spyOn, test } from "bun:test";
import { botPermissions } from "../helpers/botPermissions";
const {
  blockedUserIds,
  installBlocklistSweepHooks,
  postDiskIO,
  states,
} = await import("../helpers/blocklistSweepHarness");

const {
  dispatchBlockedRemovals,
  forgetChatBlocklistWork,
  forgetUserBlocklistRemovals,
  hydrateBlocklist,
  persistPendingBlockedRemovals,
  registerBlockedMemberRemover,
  trackBlockedRemoval,
} = await import("../../packages/infra/blocklist/outbox");

const {
  quiesceBlocklistSweepScheduler,
  settleBlockedRemoval,
} = await import("../../packages/infra/blocklist/sweep");

const {
  blocklistRemovalCounter,
  blocklistSweepPages,
  blocklistSweepState,
  pendingBlockedRemovals,
} = await import("../../packages/cache/main/blocklist");

const { logger } = await import("../../packages/infra/logger");

installBlocklistSweepHooks({
  quiesceBlocklistSweepScheduler,
  registerBlockedMemberRemover,
  settleBlockedRemoval,
  blocklistSweepPages,
  blocklistSweepState,
  pendingBlockedRemovals,
});

/** 受管且机器人是管理员——恢复保留任务的前提。 */
function governedChat(chatId: number = -1001): void {
  states.set(chatId, { isInitEnabled: true, botPermissions: botPermissions() });
}

/** 一条补扫任务（不带名单，投递时按当前黑名单现算）。 */
function sweepTask(
  removalId: number,
  overrides: Record<string, unknown> = {}
): [number, never] {
  return [removalId, {
    params: { chatId: -1001, probeMembership: true, removalId },
    createdAt: 1_000,
    attempts: 2,
    ...overrides,
  } as never];
}

/** 一条冻结名单的处置任务。 */
function frozenTask(
  removalId: number,
  userIds: readonly number[] = [7]
): [number, never] {
  return [removalId, {
    params: { chatId: -1001, probeMembership: false, removalId, userIds: [...userIds] },
    createdAt: 1_000,
    attempts: 0,
  } as never];
}

describe("黑名单 outbox 的启动恢复过滤", () => {
  test("群已不再受管：任务被丢弃并重写快照，编号水位仍前进", () => {
    // 编号水位必须跟着被丢弃的那条走，否则重启后新任务会复用旧编号，
    // Worker 端的回执按编号匹配，就会把新批次的结果记到旧批次头上。
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    states.set(-1001, { isInitEnabled: false, botPermissions: botPermissions() });

    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(blocklistRemovalCounter.current).toBe(21);
    expect(postDiskIO).toHaveBeenCalledTimes(1);
    expect(postDiskIO.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: "blocklistRemovals", removals: [] })
    );
  });

  test("机器人已不是管理员：任务同样被丢弃", () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: { isAdministrator: false } });

    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(blocklistSweepState.size).toBe(0);
  });

  test("群状态整个读不到：按未受管处理，不留任务", () => {
    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("补扫任务的名单已空：销账，不留一条永远踢不到人的补扫", () => {
    // 补扫不带名单，投递时才按当前黑名单现算；名单空了它就没有目标了。
    governedChat();

    hydrateBlocklist(new Map([sweepTask(21)]));

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(blocklistSweepState.size).toBe(0);
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("补扫任务名单非空且上次不是缺权限：重建未闩锁的补扫节奏", () => {
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    hydrateBlocklist(new Map([sweepTask(21)]));

    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(blocklistSweepState.get(-1001)).toEqual({
      removalId: 21,
      sweptAt: null,
      nextRetryAt: 1_000,
      resweepRequested: false,
      failedSweeps: 2,
      permissionBlocked: false,
    });
    // 一条都没被过滤掉，就不该多写一次快照。
    expect(postDiskIO).not.toHaveBeenCalled();
  });

  test("同群既有缺权限闩锁又有普通补扫：闩锁不被后来的普通任务覆盖", () => {
    // 闩锁是「确证过没有封禁权限」，普通补扫只是「还没轮到」。让后者覆盖前者
    // 会让补扫在没有权限的群里空转，每一轮都打一次注定失败的请求。
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    hydrateBlocklist(new Map([
      sweepTask(21, { lastFailure: "missing-permission" }),
      sweepTask(22),
    ]));

    expect(blocklistSweepState.get(-1001)).toEqual(
      expect.objectContaining({ permissionBlocked: true })
    );
    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(pendingBlockedRemovals.has(22)).toBeTrue();
  });

  test("过滤后的快照投不出去：点名记一行错误，不静默", () => {
    // 投不出去意味着落盘侧仍留着那条已经被主线程丢弃的任务，两边不一致；
    // 没有这行日志，运维手上唯一的线索就只有「有人没被踢」。
    const error = spyOn(logger, "error").mockImplementation((): void => {});
    postDiskIO.mockImplementation((): boolean => false);

    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(error).toHaveBeenCalledWith(
      "Failed to queue the filtered blocklist removal outbox after startup recovery."
    );
    error.mockRestore();
  });

  test("没有任何任务被过滤时不写快照", () => {
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    hydrateBlocklist(new Map([frozenTask(21)]));

    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(postDiskIO).not.toHaveBeenCalled();
  });

  test("冻结名单任务上次因缺权限失败：恢复出的补扫同样是闩锁态", () => {
    // 闩锁只跟「上次为什么失败」有关，与任务带不带冻结名单无关；漏了这一支，
    // 一条确证过没有封禁权限的处置会在重启后被当成普通任务反复重投。
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });

    hydrateBlocklist(new Map([[21, {
      params: { chatId: -1001, probeMembership: false, removalId: 21, userIds: [7] },
      createdAt: 1_000,
      attempts: 3,
      lastFailure: "missing-permission",
    } as never]]));

    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(blocklistSweepState.get(-1001)).toEqual({
      removalId: null,
      sweptAt: null,
      nextRetryAt: 1_000,
      resweepRequested: false,
      failedSweeps: 3,
      permissionBlocked: true,
    });
  });

  test("恢复先清空既有镜像：上一轮的任务与补扫状态不残留", () => {
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([frozenTask(21)]));
    expect(pendingBlockedRemovals.size).toBe(1);

    hydrateBlocklist(new Map());

    expect(pendingBlockedRemovals.size).toBe(0);
    expect(blocklistSweepState.size).toBe(0);
    expect(blocklistSweepPages.size).toBe(0);
    expect(blocklistRemovalCounter.current).toBe(0);
  });
});

describe("黑名单 outbox 的运行期销账", () => {
  test("最后一个目标被 /unblock 摘掉：整条任务销账并释放 sweep claim", () => {
    // 留一条空名单任务下来，补扫每一轮都会为它跑一次注定没有目标的投递。
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([frozenTask(21, [7])]));
    blocklistSweepPages.set(21, {} as never);
    postDiskIO.mockClear();

    forgetUserBlocklistRemovals(7);

    expect(pendingBlockedRemovals.has(21)).toBeFalse();
    expect(blocklistSweepPages.has(21)).toBeFalse();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("权威名单被清空：连补扫任务一起销账", () => {
    // 补扫不冻结名单，只有名单整体空了才轮得到它销账；名单还有人时不能动它，
    // 否则解封一个人会顺手取消掉针对其他人的补扫。
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    blockedUserIds.set(8, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([sweepTask(21)]));
    postDiskIO.mockClear();

    forgetUserBlocklistRemovals(7);
    expect(pendingBlockedRemovals.has(21)).toBeTrue();
    expect(postDiskIO).not.toHaveBeenCalled();

    blockedUserIds.clear();
    forgetUserBlocklistRemovals(8);

    expect(pendingBlockedRemovals.has(21)).toBeFalse();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("销账后的快照投不出去：点名被解封的那个 id", () => {
    const error = spyOn(logger, "error").mockImplementation((): void => {});
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([frozenTask(21, [7])]));
    postDiskIO.mockImplementation((): boolean => false);

    forgetUserBlocklistRemovals(7);

    expect(error).toHaveBeenCalledWith(
      "Failed to queue blocklist removal outbox cleanup for unblocked user 7."
    );
    error.mockRestore();
  });

  test("群停止管理：该群全部任务与补扫进度一起删掉", () => {
    governedChat();
    governedChat(-1002);
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([
      frozenTask(21, [7]),
      [22, {
        params: { chatId: -1002, probeMembership: false, removalId: 22, userIds: [7] },
        createdAt: 1_000,
        attempts: 0,
      } as never],
    ]));
    postDiskIO.mockClear();

    forgetChatBlocklistWork(-1001);

    expect(pendingBlockedRemovals.has(21)).toBeFalse();
    // 另一个群的任务不受牵连。
    expect(pendingBlockedRemovals.has(22)).toBeTrue();
    expect(blocklistSweepState.has(-1001)).toBeFalse();
    expect(postDiskIO).toHaveBeenCalledTimes(1);
  });

  test("群停止管理后的快照投不出去：点名那个群", () => {
    const error = spyOn(logger, "error").mockImplementation((): void => {});
    governedChat();
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/08/11 00:00:00" });
    hydrateBlocklist(new Map([frozenTask(21, [7])]));
    postDiskIO.mockImplementation((): boolean => false);

    forgetChatBlocklistWork(-1001);

    expect(error).toHaveBeenCalledWith(
      "Failed to queue blocklist removal outbox cleanup for unmanaged chat -1001."
    );
    error.mockRestore();
  });

  test("登记一条没有任何目标的处置：立刻抛错，且不把它留在镜像里", () => {
    // 留下来就是一条永远投不出去、却一直占着 outbox 容量的任务。
    governedChat();

    expect(() => trackBlockedRemoval({
      chatId: -1001,
      probeMembership: true,
    } as never)).toThrow("Blocklist removal has no target to enforce.");
    expect(pendingBlockedRemovals.size).toBe(0);
  });
});

describe("黑名单 outbox 的投递边界", () => {
  test("write-ahead 快照投不出去时抛错，不让处置抢在落盘之前发出去", async () => {
    // 先斩后奏的话，进程在封禁请求发出与落盘之间崩掉，重启后 outbox 里没有这批
    // 任务，被封的人却已经被踢——没有任何一轮补扫会再确认它。
    postDiskIO.mockImplementation((): boolean => false);

    await expect(persistPendingBlockedRemovals()).rejects.toThrow(
      "Persistence Worker rejected the blocklist removal outbox snapshot."
    );
  });

  test("投递转交当前注册的执行 owner，并原样返回投出条数", async () => {
    const batch = [{ chatId: -1001, userIds: [7], removalId: 21 }] as never;

    await expect(dispatchBlockedRemovals(batch)).resolves.toBe(1);
  });
});
