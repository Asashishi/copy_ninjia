import { describe, expect, test } from "bun:test";
import { LOCKDOWN_MS, RESTORE_RETRY_MS } from "../../src/consts/antiRaid";
import { transitionLockdown, type LockdownState } from "../../src/states/lockdown";

const PERMS = { can_send_messages: true };

describe("触发与占位", () => {
  test("INACTIVE + 超阈值 → APPLYING：预热缓存 + 起满额计时 + 发起加锁", () => {
    const { next, effects } = transitionLockdown(undefined, { type: "thresholdExceeded", joinCount: 46 });
    expect(next).toEqual({ kind: "applying" });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: true },
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "beginApply", joinCount: 46 },
    ]);
  });

  test("已在锁定中再次超阈值 → 只延长计时，不重复加锁/发通知", () => {
    for (const state of [{ kind: "applying" }, { kind: "active", originalPermissions: PERMS }] as LockdownState[]) {
      const { next, effects } = transitionLockdown(state, { type: "thresholdExceeded", joinCount: 50 });
      expect(next).toBe(state);
      expect(effects).toEqual([
        { kind: "prefetchAdmins", onlyIfCold: true },
        { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      ]);
    }
  });

  test("RESTORING 期间再次超阈值 → 回到 ACTIVE 常规倒计时", () => {
    const { next } = transitionLockdown({ kind: "restoring", originalPermissions: PERMS }, { type: "thresholdExceeded", joinCount: 50 });
    expect(next).toEqual({ kind: "active", originalPermissions: PERMS });
  });
});

describe("加锁落地", () => {
  test("成功 → ACTIVE：计时从生效时刻重新给满 + 回报镜像 + 发通知", () => {
    const { next, effects } = transitionLockdown({ kind: "applying" }, { type: "applyResult", ok: true, originalPermissions: PERMS, joinCount: 46 });
    expect(next).toEqual({ kind: "active", originalPermissions: PERMS });
    expect(effects).toEqual([
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "reportLockdown", originalPermissions: PERMS },
      { kind: "announceLockdown", joinCount: 46 },
    ]);
  });

  test("失败 → 回到 INACTIVE（下一波超阈值可以重试）", () => {
    const { next, effects } = transitionLockdown({ kind: "applying" }, { type: "applyResult", ok: false });
    expect(next).toBeUndefined();
    expect(effects).toEqual([]);
  });

  test("APPLYING 期间恢复计时到期 → 绝不拿空权限去恢复，只按短间隔轮询", () => {
    const state: LockdownState = { kind: "applying" };
    const { next, effects } = transitionLockdown(state, { type: "restoreTimerFired" });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "scheduleRestore", delayMs: RESTORE_RETRY_MS }]);
  });
});

describe("到期恢复", () => {
  test("ACTIVE 计时到期 → RESTORING + 发起恢复", () => {
    const { next, effects } = transitionLockdown({ kind: "active", originalPermissions: PERMS }, { type: "restoreTimerFired" });
    expect(next).toEqual({ kind: "restoring", originalPermissions: PERMS });
    expect(effects).toEqual([{ kind: "beginRestore", originalPermissions: PERMS }]);
  });

  test("恢复成功 → INACTIVE + 回报解锁 + 发通知", () => {
    const { next, effects } = transitionLockdown({ kind: "restoring", originalPermissions: PERMS }, { type: "restoreResult", ok: true });
    expect(next).toBeUndefined();
    expect(effects).toEqual([{ kind: "reportUnlock" }, { kind: "announceUnlock" }]);
  });

  test("恢复失败 → 保留记录稍后重试（unlock 不发出，与权限仍被限制的事实一致）", () => {
    const state: LockdownState = { kind: "restoring", originalPermissions: PERMS };
    const { next, effects } = transitionLockdown(state, { type: "restoreResult", ok: false });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "scheduleRestore", delayMs: RESTORE_RETRY_MS }]);
  });

  test("恢复在途期间被新峰值推回 ACTIVE，迟到的成功回执原地补一次限制而非解锁", () => {
    const state: LockdownState = { kind: "active", originalPermissions: PERMS };
    const { next, effects } = transitionLockdown(state, { type: "restoreResult", ok: true });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "reapplyRestriction", originalPermissions: PERMS }]);
  });

  test("恢复在途期间被新峰值推回 ACTIVE，迟到的失败回执被忽略（权限从未恢复过，别打断刚延长的倒计时）", () => {
    const state: LockdownState = { kind: "active", originalPermissions: PERMS };
    const { next, effects } = transitionLockdown(state, { type: "restoreResult", ok: false });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});

describe("adopt 接管", () => {
  test("INACTIVE + adopt → 直接视为已生效的 ACTIVE，无条件预热缓存 + 满额计时", () => {
    const { next, effects } = transitionLockdown(undefined, { type: "adopt", originalPermissions: PERMS });
    expect(next).toEqual({ kind: "active", originalPermissions: PERMS });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: false },
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
    ]);
  });

  test("已有记录时 adopt 幂等跳过", () => {
    const state: LockdownState = { kind: "active", originalPermissions: PERMS };
    const { next, effects } = transitionLockdown(state, { type: "adopt", originalPermissions: {} });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
