/** 黑名单主键跨线程读失败时的降级、re-arm 与忙等防护。 */

import { describe, expect, test } from "bun:test";
import { botPermissions } from "../helpers/botPermissions";
const {
  blockedUserIds,
  expectLastRemoval,
  installBlocklistSweepHooks,
  remover,
  setBlocklistIdReads,
  states,
} = await import("../helpers/blocklistSweepHarness");

const {
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
  blocklistSweepSchedulerState,
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

describe("黑名单主键读失败的降级边界", () => {
  /** Disk I/O 自愈窗口里跨线程读直接 reject。 */
  function failBlocklistIdReads(): void {
    setBlocklistIdReads((): Promise<readonly number[]> =>
      Promise.reject(new Error("Persistence Worker is unavailable; cannot read blocklist IDs.")));
  }

  test("sweepBlockedMembers 的读失败仍会重新武装补扫时钟", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    initBlocklistSweepScheduler();
    requestBlocklistResweep(-1001, Date.now() + 60_000);
    failBlocklistIdReads();

    // 读落在 try/finally 之外时这次 reject 会整体跳过 finally，
    // armBlocklistSweepScheduler 本次不执行，周期补扫在本进程里再也不触发。
    await expect(sweepBlockedMembers(-1001)).rejects.toThrow("cannot read blocklist IDs");
    expect(blocklistSweepSchedulerState.timer).not.toBeNull();
    quiesceBlocklistSweepScheduler();
  });

  test("多群补扫的读失败按退避排下一轮，不把失败抛给调度器形成忙等", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    failBlocklistIdReads();

    await expect(sweepManagedBlocklistChats(1_000)).resolves.toBeUndefined();

    expect(remover).not.toHaveBeenCalled();
    // 早已过期的 nextRetryAt 会让 finally 里的重排立刻再跑一轮；必须推到窗口之外。
    expect(blocklistSweepState.get(-1001)?.nextRetryAt).toBeGreaterThan(1_000);
  });

  test("重放遇读失败时冻结批次照常重投，只跳过需要现算名单的补扫", async () => {
    blockedUserIds.set(7, { isBlocked: true, blockedAt: "2026/07/26 00:00:00" });
    states.set(-1001, { isInitEnabled: true, botPermissions: botPermissions() });
    states.set(-1002, { isInitEnabled: true, botPermissions: botPermissions() });
    // 一条冻结批次（/block 秒踢）和一条补扫批次。
    trackBlockedRemoval({ chatId: -1001, probeMembership: false, userIds: [7] });
    trackBlockedRemoval({ chatId: -1002, probeMembership: true }, [7]);
    remover.mockClear();
    failBlocklistIdReads();

    replayPendingBlockedRemovals();
    await Bun.sleep(0);

    // 整体 return 会让冻结批次永久丢失：它们没有 timer、没有退避，重试钩子只有
    // 「下一次 Worker 重建」和「一次确证的权限恢复」，而 /block 早已回执成功。
    expect(remover).toHaveBeenCalledTimes(1);
    expectLastRemoval({ chatId: -1001, userIds: [7], probeMembership: false });
    // 被跳过的补扫没有任何回执可等，必须重新欠一次。
    expect(blocklistSweepState.get(-1002)?.sweptAt).toBeNull();
    expect(blocklistSweepState.get(-1002)?.nextRetryAt).toBeGreaterThan(0);
  });
});
