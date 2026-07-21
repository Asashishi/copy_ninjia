import { describe, expect, test } from "bun:test";
import { LOCKDOWN_MS, RESTORE_RETRY_MS } from "../../src/consts/antiRaid";
import { transitionLockdown } from "../../src/states/lockdown";
import type { LockdownState } from "../../src/types/states/lockdown";

const PERMS = { can_send_messages: true };
const ACTIVE: LockdownState = { kind: "active", originalPermissions: PERMS, intentId: 1 };
const RESTORING: LockdownState = { kind: "restoring", originalPermissions: PERMS, intentId: 2 };

describe("触发与占位", () => {
  test("INACTIVE + 超阈值 → APPLYING：预热缓存 + 只读取原权限", () => {
    const { next, effects } = transitionLockdown(undefined, { type: "thresholdExceeded", joinCount: 46 });
    expect(next).toEqual({ kind: "applying" });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: true },
      { kind: "prepareApply", joinCount: 46 },
    ]);
  });

  test("APPLYING 中再次超阈值 → 保持占位，不重复读取或修改权限", () => {
    const state: LockdownState = { kind: "applying" };
    const { next, effects } = transitionLockdown(state, { type: "thresholdExceeded", joinCount: 50 });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "prefetchAdmins", onlyIfCold: true }]);
  });

  test("ACTIVE 中再次超阈值 → 延长计时并刷新持久化截止时间，不重复加锁/发通知", () => {
    const state: LockdownState = ACTIVE;
    const { next, effects } = transitionLockdown(state, { type: "thresholdExceeded", joinCount: 50 });
    expect(next).toBe(state);
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: true },
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "persistState" },
    ]);
  });

  test("RESTORING 期间再次超阈值 → 回到 ACTIVE，刷新计时与持久化截止时间", () => {
    const { next, effects } = transitionLockdown(RESTORING, { type: "thresholdExceeded", joinCount: 50 });
    expect(next).toEqual({ kind: "active", originalPermissions: PERMS, intentId: 2 });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: true },
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "persistState" },
    ]);
  });
});

describe("加锁落地", () => {
  test("原权限先形成 applying intent，落盘回执后才允许 setChatPermissions", () => {
    const prepared = transitionLockdown({ kind: "applying" }, {
      type: "applyPrepared", originalPermissions: PERMS, joinCount: 46, intentId: 7,
    });
    expect(prepared.next).toEqual({ kind: "applying", originalPermissions: PERMS, joinCount: 46, intentId: 7 });
    expect(prepared.effects).toEqual([{ kind: "persistState" }]);
    expect(transitionLockdown(prepared.next, { type: "statePersisted", phase: "applying", intentId: 6 }).effects).toEqual([]);
    expect(transitionLockdown(prepared.next, { type: "statePersisted", phase: "applying", intentId: 7 }).effects).toEqual([
      { kind: "commitApply", originalPermissions: PERMS },
    ]);
  });

  test("set 成功 → ACTIVE：计时从生效时刻重新给满 + 持久化 active + 发通知", () => {
    const applying: LockdownState = { kind: "applying", originalPermissions: PERMS, joinCount: 46, intentId: 7 };
    const { next, effects } = transitionLockdown(applying, { type: "applyResult", ok: true });
    expect(next).toEqual({ kind: "active", originalPermissions: PERMS, intentId: 7 });
    expect(effects).toEqual([
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "persistState" },
      { kind: "announceLockdown", joinCount: 46 },
    ]);
  });

  test("接管 applying 后 set 成功 → 人数未知时公告不伪造为 0", () => {
    const adopted = transitionLockdown(undefined, {
      type: "adopt", phase: "applying", intentId: 7, originalPermissions: PERMS, remainingMs: 0,
    });
    const { effects } = transitionLockdown(adopted.next, { type: "applyResult", ok: true });
    expect(effects).toEqual([
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "persistState" },
      { kind: "announceLockdown" },
    ]);
  });

  test("set 结果不确定 → 先持久化 restoring 再恢复，不能删除 owner", () => {
    const applying: LockdownState = { kind: "applying", originalPermissions: PERMS, intentId: 7 };
    const { next, effects } = transitionLockdown(applying, { type: "applyResult", ok: false, restoreIntentId: 8 });
    expect(next).toEqual({ kind: "restoring", originalPermissions: PERMS, intentId: 8 });
    expect(effects).toEqual([{ kind: "persistState" }]);
  });

  test("读取原权限失败 → 删除尚未落盘、也从未改权限的占位", () => {
    const state: LockdownState = { kind: "applying" };
    const { next, effects } = transitionLockdown(state, { type: "applyPreparationFailed" });
    expect(next).toBeUndefined();
    expect(effects).toEqual([]);
  });
});

describe("到期恢复", () => {
  test("ACTIVE 计时到期 → 先持久化 RESTORING，回执后才发起恢复", () => {
    const { next, effects } = transitionLockdown(ACTIVE, { type: "restoreTimerFired", intentId: 2 });
    expect(next).toEqual({ kind: "restoring", originalPermissions: PERMS, intentId: 2 });
    expect(effects).toEqual([{ kind: "persistState" }]);
    expect(transitionLockdown(next, { type: "statePersisted", phase: "restoring", intentId: 2 }).effects).toEqual([
      { kind: "beginRestore", originalPermissions: PERMS },
    ]);
  });

  test("恢复成功 → INACTIVE + 回报解锁 + 发通知", () => {
    const { next, effects } = transitionLockdown(RESTORING, { type: "restoreResult", ok: true });
    expect(next).toBeUndefined();
    expect(effects).toEqual([{ kind: "reportUnlock" }, { kind: "announceUnlock" }]);
  });

  test("恢复失败 → 保留记录稍后重试（unlock 不发出，与权限仍被限制的事实一致）", () => {
    const state: LockdownState = RESTORING;
    const { next, effects } = transitionLockdown(state, { type: "restoreResult", ok: false });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "scheduleRestoreRetry", delayMs: RESTORE_RETRY_MS }]);
  });

  test("恢复在途期间被新峰值推回 ACTIVE，迟到的成功回执原地补一次限制而非解锁", () => {
    const state: LockdownState = ACTIVE;
    const { next, effects } = transitionLockdown(state, { type: "restoreResult", ok: true });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "reapplyRestriction", originalPermissions: PERMS }]);
  });

  test("恢复在途期间被新峰值推回 ACTIVE，迟到的失败回执被忽略（权限从未恢复过，别打断刚延长的倒计时）", () => {
    const state: LockdownState = ACTIVE;
    const { next, effects } = transitionLockdown(state, { type: "restoreResult", ok: false });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

describe("adopt 接管", () => {
  test("INACTIVE + adopt → 直接视为已生效的 ACTIVE，无条件预热缓存 + 按调用方算好的真实剩余时长重排计时（回归：曾无条件重开满额，快到期的锁定会被意外延长）", () => {
    const remainingMs = 42_000; // 模拟"锁定只剩 42 秒就该恢复"，而非满额的 LOCKDOWN_MS
    const { next, effects } = transitionLockdown(undefined, {
      type: "adopt", phase: "active", intentId: 1, originalPermissions: PERMS, remainingMs,
    });
    expect(next).toEqual({ kind: "active", originalPermissions: PERMS, intentId: 1 });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: false },
      { kind: "scheduleRestore", delayMs: remainingMs },
    ]);
  });

  test("剩余时长恰好算出 0（崩溃期间已经过期）→ 立即安排恢复，不无谓多等", () => {
    const { effects } = transitionLockdown(undefined, {
      type: "adopt", phase: "active", intentId: 1, originalPermissions: PERMS, remainingMs: 0,
    });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: false },
      { kind: "scheduleRestore", delayMs: 0 },
    ]);
  });

  test("已有记录时 adopt 幂等跳过", () => {
    const state: LockdownState = ACTIVE;
    const { next, effects } = transitionLockdown(state, {
      type: "adopt", phase: "active", intentId: 9, originalPermissions: {}, remainingMs: LOCKDOWN_MS,
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  test("恢复 applying/restoring intent 时立即幂等对账", () => {
    const applying = transitionLockdown(undefined, {
      type: "adopt", phase: "applying", intentId: 7, originalPermissions: PERMS, remainingMs: 0,
    });
    expect(applying.next).toEqual({ kind: "applying", originalPermissions: PERMS, intentId: 7 });
    expect(applying.effects.map((effect) => effect.kind)).toEqual(["prefetchAdmins", "commitApply"]);

    const restoring = transitionLockdown(undefined, {
      type: "adopt", phase: "restoring", intentId: 8, originalPermissions: PERMS, remainingMs: 0,
    });
    expect(restoring.next).toEqual({ kind: "restoring", originalPermissions: PERMS, intentId: 8 });
    expect(restoring.effects.map((effect) => effect.kind)).toEqual(["prefetchAdmins", "beginRestore"]);
  });

  test("Worker 重建接到尚未落盘的 intent 时只接管状态，精确回执后才执行权限副作用", () => {
    const applying = transitionLockdown(undefined, {
      type: "adopt", phase: "applying", intentId: 7, originalPermissions: PERMS, remainingMs: 0, persisted: false,
    });
    expect(applying.effects.map((effect) => effect.kind)).toEqual(["prefetchAdmins"]);
    expect(transitionLockdown(applying.next, {
      type: "statePersisted", phase: "applying", intentId: 7,
    }).effects.map((effect) => effect.kind)).toEqual(["commitApply"]);

    const restoring = transitionLockdown(undefined, {
      type: "adopt", phase: "restoring", intentId: 8, originalPermissions: PERMS, remainingMs: 0, persisted: false,
    });
    expect(restoring.effects.map((effect) => effect.kind)).toEqual(["prefetchAdmins"]);
    expect(transitionLockdown(restoring.next, {
      type: "statePersisted", phase: "restoring", intentId: 8,
    }).effects.map((effect) => effect.kind)).toEqual(["beginRestore"]);
  });
});
