import { describe, expect, test } from "bun:test";
import {
  LOCKDOWN_MS,
  LOCKDOWN_RETRIGGER_COOLDOWN_MS,
  RESTORE_RETRY_MS,
} from "../../packages/consts/antiRaid/lockdown";
import { transitionLockdown } from "../../packages/states/lockdown";
import type {
  LockdownAbandonReason,
  LockdownAnnouncement,
  LockdownEffect,
  LockdownState,
} from "../../packages/types/states/lockdown";

/** 本轮作废时压制重触发：只应出现在真的把这一轮丢掉的那几条转移上。 */
function suppression(reason: LockdownAbandonReason): LockdownEffect {
  return { kind: "suppressRetrigger", reason, durationMs: LOCKDOWN_RETRIGGER_COOLDOWN_MS };
}

const PERMS = { can_send_messages: true };
const ANNOUNCEMENT_MESSAGE_ID = 900;
/** 封锁公告已发出并留下可删除的 message ID（占位落地时就发了，见状态机注释）。 */
const ANNOUNCED: LockdownAnnouncement = {
  announced: true,
  announcementPending: false,
  announcementMessageId: ANNOUNCEMENT_MESSAGE_ID,
};
/** 公告一次也没发出去：解除时既不删消息，也不发解锁公告。 */
const SILENT: LockdownAnnouncement = {
  announced: false,
  announcementPending: false,
  announcementMessageId: undefined,
};
const ACTIVE: LockdownState = {
  kind: "active",
  originalPermissions: PERMS,
  intentId: 1,
  ...ANNOUNCED,
};
const RESTORING: LockdownState = {
  kind: "restoring",
  originalPermissions: PERMS,
  intentId: 2,
  restoreAfterPersist: false,
  ...ANNOUNCED,
};
const PREPARED: LockdownState = {
  kind: "applying",
  stage: "prepared",
  originalPermissions: PERMS,
  intentId: 7,
  commitStarted: false,
  ...ANNOUNCED,
};

describe("触发与占位", () => {
  test("INACTIVE + 超阈值 → APPLYING：预热缓存 + 先在群里报告封锁 + 只读取原权限", () => {
    const { next, effects } = transitionLockdown(undefined, { type: "thresholdExceeded", joinCount: 46 });
    expect(next).toEqual({
      kind: "applying",
      stage: "preparing",
      announced: false,
      announcementPending: true,
      announcementMessageId: undefined,
    });
    // 公告排在读权限之前：占位一落地，新进群的人就被直接请出去，群里必须有交代。
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: true },
      { kind: "beginLockdownAnnouncement", joinCount: 46 },
      { kind: "prepareApply", joinCount: 46 },
    ]);
  });

  test("APPLYING 中再次超阈值 → 保持占位，不重复读取权限，也不重复公告", () => {
    const state: LockdownState = {
      kind: "applying",
      stage: "preparing",
      announced: false,
      announcementPending: true,
      announcementMessageId: undefined,
    };
    const { next, effects } = transitionLockdown(state, { type: "thresholdExceeded", joinCount: 50 });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "prefetchAdmins", onlyIfCold: true }]);
  });

  test("ACTIVE 中再次超阈值 → 只预热管理员表：本轮倒计时不再被推后", () => {
    // ACTIVE 状态下再次超阈值不能重排倒计时，否则持续刷群会让同一轮无限续期。
    const state: LockdownState = ACTIVE;
    const { next, effects } = transitionLockdown(state, { type: "thresholdExceeded", joinCount: 50 });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "prefetchAdmins", onlyIfCold: true }]);
  });

  test("RECONCILING 中再次超阈值 → 同样不重排倒计时", () => {
    const state: LockdownState = {
      kind: "reconciling",
      originalPermissions: PERMS,
      intentId: 1,
      reapplyAfterPersist: false,
      ...ANNOUNCED,
    };
    const { next, effects } = transitionLockdown(state, { type: "thresholdExceeded", joinCount: 90 });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "prefetchAdmins", onlyIfCold: true }]);
  });

  test("RESTORING 期间再次超阈值 → 新一轮：回到 ACTIVE 并重新给满倒计时", () => {
    const { next, effects } = transitionLockdown(RESTORING, { type: "thresholdExceeded", joinCount: 50 });
    expect(next).toEqual({
      kind: "active",
      originalPermissions: PERMS,
      intentId: 2,
      ...ANNOUNCED,
    });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: true },
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "persistState" },
    ]);
  });
});

describe("封锁公告", () => {
  test("公告发送成功 → 记下 message ID 并持久化（重启后才删得掉那条公告）", () => {
    const pending: LockdownState = { ...PREPARED, ...SILENT, announcementPending: true };
    const sent = transitionLockdown(pending, {
      type: "announcementResult",
      ok: true,
      messageId: ANNOUNCEMENT_MESSAGE_ID,
    });
    expect(sent.next).toEqual({ ...pending, ...ANNOUNCED });
    expect(sent.effects).toEqual([{ kind: "persistState" }]);
  });

  test("没有在途公告时的结果一律忽略（重复回执不得再写一次状态）", () => {
    expect(transitionLockdown(PREPARED, {
      type: "announcementResult",
      ok: true,
      messageId: 901,
    })).toEqual({ next: PREPARED, effects: [] });
  });

  test("公告发送失败 → 只落下「不再在途」，announced 保持 false", () => {
    const pending: LockdownState = { ...PREPARED, ...SILENT, announcementPending: true };
    const { next, effects } = transitionLockdown(pending, { type: "announcementResult", ok: false });
    expect(next).toEqual({ ...pending, announcementPending: false });
    expect(effects).toEqual([]);
  });

  test("preparing 阶段的公告结果不发落盘副作用（还没有可持久化的 intent）", () => {
    const preparing: LockdownState = {
      kind: "applying",
      stage: "preparing",
      announced: false,
      announcementPending: true,
      announcementMessageId: undefined,
    };
    const { next, effects } = transitionLockdown(preparing, {
      type: "announcementResult",
      ok: true,
      messageId: ANNOUNCEMENT_MESSAGE_ID,
    });
    expect(next).toEqual({ ...preparing, ...ANNOUNCED });
    expect(effects).toEqual([]);
  });

  test("本轮已经结束后才拿到公告 ID → 直接删掉这条没有主人的公告", () => {
    const { next, effects } = transitionLockdown(undefined, {
      type: "announcementResult",
      ok: true,
      messageId: ANNOUNCEMENT_MESSAGE_ID,
    });
    expect(next).toBeUndefined();
    expect(effects).toEqual([
      { kind: "deleteLockdownAnnouncement", messageId: ANNOUNCEMENT_MESSAGE_ID },
    ]);

    expect(transitionLockdown(undefined, { type: "announcementResult", ok: false })).toEqual({
      next: undefined,
      effects: [],
    });
  });
});

describe("加锁落地", () => {
  test("原权限先形成 applying intent，落盘回执后才允许 setChatPermissions", () => {
    const preparing: LockdownState = {
      kind: "applying",
      stage: "preparing",
      ...ANNOUNCED,
    };
    const prepared = transitionLockdown(preparing, {
      type: "applyPrepared", originalPermissions: PERMS, joinCount: 46, intentId: 7,
    });
    expect(prepared.next).toEqual({
      kind: "applying",
      stage: "prepared",
      originalPermissions: PERMS,
      joinCount: 46,
      intentId: 7,
      commitStarted: false,
      ...ANNOUNCED,
    });
    expect(prepared.effects).toEqual([{ kind: "persistState" }]);
    expect(transitionLockdown(prepared.next, { type: "statePersisted", phase: "applying", intentId: 6 }).effects).toEqual([]);
    const committed = transitionLockdown(prepared.next, { type: "statePersisted", phase: "applying", intentId: 7 });
    expect(committed.effects).toEqual([{ kind: "commitApply" }]);

    // 同一份 intent 的落盘回执可能到达多次（公告结果落盘、主线程对账重跑），
    // 但 commitApply 是一次真实的 setChatPermissions，只能发一次。
    expect(committed.next).toEqual({
      kind: "applying",
      stage: "prepared",
      originalPermissions: PERMS,
      joinCount: 46,
      intentId: 7,
      commitStarted: true,
      ...ANNOUNCED,
    });
    expect(transitionLockdown(committed.next, {
      type: "statePersisted", phase: "applying", intentId: 7,
    })).toEqual({ next: committed.next, effects: [] });
  });

  test("set 成功 → ACTIVE：只排恢复计时与落盘，公告在占位时就发过了", () => {
    const applying: LockdownState = { ...PREPARED, joinCount: 46 } as LockdownState;
    const { next, effects } = transitionLockdown(applying, { type: "applyResult", ok: true });
    expect(next).toEqual({
      kind: "active",
      originalPermissions: PERMS,
      intentId: 7,
      ...ANNOUNCED,
    });
    expect(effects).toEqual([
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "persistState" },
    ]);
    expect(transitionLockdown(next, {
      type: "statePersisted",
      phase: "active",
      intentId: 7,
    }).effects).toEqual([]);
  });

  test("set 结果不确定 → 先持久化 restoring 再恢复，并带走真实公告记账", () => {
    const { next, effects } = transitionLockdown(PREPARED, { type: "applyResult", ok: false, restoreIntentId: 8 });
    // 公告在 APPLYING 就发出去了：恢复成功时要删掉它，并发一条解锁公告。
    expect(next).toEqual({
      kind: "restoring",
      originalPermissions: PERMS,
      intentId: 8,
      restoreAfterPersist: true,
      ...ANNOUNCED,
    });
    expect(effects).toEqual([{ kind: "persistState" }]);
  });

  test("读取原权限失败 → 删除占位，并撤掉刚发出去的封锁公告", () => {
    const state: LockdownState = { kind: "applying", stage: "preparing", ...ANNOUNCED };
    const { next, effects } = transitionLockdown(state, { type: "applyPreparationFailed" });
    expect(next).toBeUndefined();
    expect(effects).toEqual([
      { kind: "deleteLockdownAnnouncement", messageId: ANNOUNCEMENT_MESSAGE_ID },
      suppression("preparationFailed"),
    ]);
  });

  test("公告还在途时读取原权限失败 → 不猜 ID，等结果到达后由 INACTIVE 分支删除", () => {
    const state: LockdownState = {
      kind: "applying",
      stage: "preparing",
      announced: false,
      announcementPending: true,
      announcementMessageId: undefined,
    };
    const { next, effects } = transitionLockdown(state, { type: "applyPreparationFailed" });
    expect(next).toBeUndefined();
    expect(effects).toEqual([suppression("preparationFailed")]);
  });

  test("准备阶段忽略落盘完成与应用结果事件", () => {
    const state: LockdownState = { kind: "applying", stage: "preparing", ...ANNOUNCED };
    const persisted = transitionLockdown(state, {
      type: "statePersisted",
      phase: "applying",
      intentId: 7,
    });
    const applied = transitionLockdown(state, { type: "applyResult", ok: true });

    expect(persisted).toEqual({ next: state, effects: [] });
    expect(applied).toEqual({ next: state, effects: [] });
  });

  test("已准备阶段忽略读取原权限失败事件", () => {
    const result = transitionLockdown(PREPARED, { type: "applyPreparationFailed" });

    expect(result).toEqual({ next: PREPARED, effects: [] });
  });

  test("提交前刷新权限失败 → 删除已落盘但尚未写 Telegram 的 intent，并撤掉公告", () => {
    const { next, effects } = transitionLockdown(PREPARED, { type: "applyCommitPreparationFailed" });
    expect(next).toBeUndefined();
    expect(effects).toEqual([
      { kind: "reportUnlock" },
      { kind: "deleteLockdownAnnouncement", messageId: ANNOUNCEMENT_MESSAGE_ID },
      suppression("commitPreparationFailed"),
    ]);
  });
});

describe("落盘失败一律 fail-safe 打开", () => {
  test("APPLYING intent 落不了盘 → 撤销占位并撤掉公告（从未改过权限）", () => {
    const { next, effects } = transitionLockdown(PREPARED, {
      type: "persistFailed",
      phase: "applying",
      intentId: 7,
    });
    // 落盘失败必须清除 APPLYING 占位，不能留下永久秒踢且无恢复计时的状态。
    expect(next).toBeUndefined();
    expect(effects).toEqual([
      { kind: "reportUnlock" },
      { kind: "deleteLockdownAnnouncement", messageId: ANNOUNCEMENT_MESSAGE_ID },
      suppression("persistFailed"),
    ]);
  });

  test("ACTIVE 落不了盘 → 立刻恢复原权限，不再等落盘回执", () => {
    const { next, effects } = transitionLockdown(ACTIVE, {
      type: "persistFailed",
      phase: "active",
      intentId: 1,
    });
    expect(next).toEqual({
      kind: "restoring",
      originalPermissions: PERMS,
      intentId: 1,
      restoreAfterPersist: false,
      ...ANNOUNCED,
    });
    expect(effects).toEqual([
      { kind: "beginRestore", originalPermissions: PERMS },
      suppression("persistFailed"),
    ]);
  });

  test("RECONCILING 落不了盘 → 同样立刻恢复", () => {
    const state: LockdownState = {
      kind: "reconciling",
      originalPermissions: PERMS,
      intentId: 1,
      reapplyAfterPersist: true,
      ...ANNOUNCED,
    };
    const { next, effects } = transitionLockdown(state, {
      type: "persistFailed",
      phase: "reconciling",
      intentId: 1,
    });
    expect(next).toEqual({
      kind: "restoring",
      originalPermissions: PERMS,
      intentId: 1,
      restoreAfterPersist: false,
      ...ANNOUNCED,
    });
    expect(effects).toEqual([
      { kind: "beginRestore", originalPermissions: PERMS },
      suppression("persistFailed"),
    ]);
  });

  test("等落盘回执才恢复的 RESTORING → 回执永远不会来了，直接恢复", () => {
    const waiting: LockdownState = { ...RESTORING, restoreAfterPersist: true };
    const { next, effects } = transitionLockdown(waiting, {
      type: "persistFailed",
      phase: "restoring",
      intentId: 2,
    });
    expect(next).toEqual({ ...waiting, restoreAfterPersist: false });
    expect(effects).toEqual([
      { kind: "beginRestore", originalPermissions: PERMS },
      suppression("persistFailed"),
    ]);

    // 恢复已经在途：迟到的失败通知不得再排一次重复的恢复。
    expect(transitionLockdown(RESTORING, {
      type: "persistFailed",
      phase: "restoring",
      intentId: 2,
    })).toEqual({ next: RESTORING, effects: [] });
  });

  test("阶段或 intent 对不上的落盘失败通知一律忽略", () => {
    expect(transitionLockdown(ACTIVE, {
      type: "persistFailed",
      phase: "active",
      intentId: 999,
    })).toEqual({ next: ACTIVE, effects: [] });
    expect(transitionLockdown(ACTIVE, {
      type: "persistFailed",
      phase: "restoring",
      intentId: 1,
    })).toEqual({ next: ACTIVE, effects: [] });
    expect(transitionLockdown(undefined, {
      type: "persistFailed",
      phase: "active",
      intentId: 1,
    })).toEqual({ next: undefined, effects: [] });
  });
});

describe("到期恢复", () => {
  test("ACTIVE 计时到期 → 先持久化 RESTORING，回执后才发起恢复", () => {
    const { next, effects } = transitionLockdown(ACTIVE, { type: "restoreTimerFired", intentId: 2 });
    expect(next).toEqual({
      kind: "restoring",
      originalPermissions: PERMS,
      intentId: 2,
      restoreAfterPersist: true,
      ...ANNOUNCED,
    });
    expect(effects).toEqual([{ kind: "persistState" }]);
    const persisted = transitionLockdown(next, {
      type: "statePersisted",
      phase: "restoring",
      intentId: 2,
    });
    expect(persisted.effects).toEqual([
      { kind: "beginRestore", originalPermissions: PERMS },
    ]);
    expect(transitionLockdown(persisted.next, {
      type: "statePersisted",
      phase: "restoring",
      intentId: 2,
    }).effects).toEqual([]);
  });

  test("恢复成功 → INACTIVE + 回报解锁 + 删掉封锁公告 + 发解锁通知", () => {
    const { next, effects } = transitionLockdown(RESTORING, { type: "restoreResult", ok: true });
    expect(next).toBeUndefined();
    expect(effects).toEqual([
      { kind: "reportUnlock" },
      { kind: "deleteLockdownAnnouncement", messageId: ANNOUNCEMENT_MESSAGE_ID },
      { kind: "announceUnlock" },
    ]);
  });

  test("公告没发出去的那条路恢复成功 → 只回报解锁，不删也不发", () => {
    // 公告发送失败 → RESTORING（announced=false）→ 恢复成功。这个群从头到尾
    // 没收到过封锁公告，再发一句「限制解除」读起来就是没头没尾的一句话。
    const silent: LockdownState = { ...RESTORING, ...SILENT };
    const { next, effects } = transitionLockdown(silent, { type: "restoreResult", ok: true });

    expect(next).toBeUndefined();
    // reportUnlock 照发：主线程要据此清掉持久化记录，与公告是两件事。
    expect(effects).toEqual([{ kind: "reportUnlock" }]);
  });

  test("未公告的 RESTORING 被新峰值推回 ACTIVE 后，仍然不会凭空发出解锁公告", () => {
    // 回到 ACTIVE 那一步不重发封锁公告，因此公告记账必须原样带过去；
    // 否则这条回头路会把「没公告过」洗成「公告过」。
    const silent: LockdownState = { ...RESTORING, ...SILENT };
    const active = transitionLockdown(silent, { type: "thresholdExceeded", joinCount: 50 });
    expect(active.next).toEqual({
      kind: "active",
      originalPermissions: PERMS,
      intentId: 2,
      ...SILENT,
    });

    const back = transitionLockdown(active.next, { type: "restoreTimerFired", intentId: 9 });
    expect(back.next).toEqual({
      kind: "restoring",
      originalPermissions: PERMS,
      intentId: 9,
      restoreAfterPersist: true,
      ...SILENT,
    });
    expect(transitionLockdown(back.next, { type: "restoreResult", ok: true }).effects).toEqual([
      { kind: "reportUnlock" },
    ]);
  });

  test("APPLYING 阶段被解除 → RESTORING，公告记账原样带走", () => {
    const { next } = transitionLockdown(PREPARED, { type: "deactivate", intentId: 8 });
    expect(next).toEqual({
      kind: "restoring",
      originalPermissions: PERMS,
      intentId: 8,
      restoreAfterPersist: true,
      ...ANNOUNCED,
    });
  });

  test("preparing 阶段被解除 → 直接撤销占位并撤掉公告", () => {
    const state: LockdownState = { kind: "applying", stage: "preparing", ...ANNOUNCED };
    const { next, effects } = transitionLockdown(state, { type: "deactivate", intentId: 8 });
    expect(next).toBeUndefined();
    expect(effects).toEqual([
      { kind: "deleteLockdownAnnouncement", messageId: ANNOUNCEMENT_MESSAGE_ID },
    ]);
  });

  test("恢复失败 → 保留记录稍后重试（unlock 不发出，与权限仍被限制的事实一致）", () => {
    const state: LockdownState = RESTORING;
    const { next, effects } = transitionLockdown(state, { type: "restoreResult", ok: false });
    expect(next).toBe(state);
    expect(effects).toEqual([{ kind: "scheduleRestoreRetry", delayMs: RESTORE_RETRY_MS }]);
  });

  test("恢复在途期间被新峰值推回 ACTIVE，迟到的成功回执先持久化 RECONCILING", () => {
    const state: LockdownState = ACTIVE;
    const { next, effects } = transitionLockdown(state, { type: "restoreResult", ok: true });
    expect(next).toEqual({
      kind: "reconciling",
      originalPermissions: PERMS,
      intentId: 1,
      reapplyAfterPersist: true,
      ...ANNOUNCED,
    });
    expect(effects).toEqual([{ kind: "persistState" }]);
    const persisted = transitionLockdown(next, {
      type: "statePersisted",
      phase: "reconciling",
      intentId: 1,
    });
    expect(persisted.effects).toEqual([{ kind: "beginReapply" }]);
    expect(transitionLockdown(persisted.next, {
      type: "statePersisted",
      phase: "reconciling",
      intentId: 1,
    }).effects).toEqual([]);
  });

  test("RECONCILING 纠偏失败退避重试，成功后才回到 ACTIVE", () => {
    const state: LockdownState = {
      kind: "reconciling",
      originalPermissions: PERMS,
      intentId: 1,
      reapplyAfterPersist: false,
      ...ANNOUNCED,
    };
    const failed = transitionLockdown(state, { type: "reapplyResult", ok: false });
    expect(failed.next).toBe(state);
    expect(failed.effects).toEqual([{
      kind: "scheduleReapplyRetry",
      delayMs: RESTORE_RETRY_MS,
    }]);
    expect(transitionLockdown(state, { type: "reapplyRetryFired" }).effects).toEqual([
      { kind: "beginReapply" },
    ]);

    const succeeded = transitionLockdown(state, { type: "reapplyResult", ok: true });
    expect(succeeded.next).toEqual(ACTIVE);
    expect(succeeded.effects).toEqual([{ kind: "persistState" }]);
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
      type: "adopt",
      phase: "active",
      intentId: 1,
      originalPermissions: PERMS,
      announced: true,
      announcementMessageId: ANNOUNCEMENT_MESSAGE_ID,
      remainingMs,
    });
    // 接管方只认落盘下来的公告记账：上一代那次发送的结局已无从追认。
    expect(next).toEqual({
      kind: "active",
      originalPermissions: PERMS,
      intentId: 1,
      ...ANNOUNCED,
    });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: false },
      { kind: "scheduleRestore", delayMs: remainingMs },
    ]);
  });

  test("接管的记录没有公告 ID → 解除时不删消息，也不猜 ID", () => {
    const { next } = transitionLockdown(undefined, {
      type: "adopt", phase: "active", intentId: 1, originalPermissions: PERMS, announced: true, remainingMs: 0,
    });
    expect(next).toEqual({
      kind: "active",
      originalPermissions: PERMS,
      intentId: 1,
      announced: true,
      announcementPending: false,
      announcementMessageId: undefined,
    });
    const restoring = transitionLockdown(next, { type: "restoreTimerFired", intentId: 2 });
    const persisted = transitionLockdown(restoring.next, {
      type: "statePersisted", phase: "restoring", intentId: 2,
    });
    expect(transitionLockdown(persisted.next, { type: "restoreResult", ok: true }).effects).toEqual([
      { kind: "reportUnlock" },
      { kind: "announceUnlock" },
    ]);
  });

  test("接管一条没公告过的锁定 → 补发公告（群里必须知道自己为什么进不来人）", () => {
    const active = transitionLockdown(undefined, {
      type: "adopt", phase: "active", intentId: 1, originalPermissions: PERMS, announced: false, remainingMs: 60_000,
    });
    expect(active.next).toEqual({
      kind: "active",
      originalPermissions: PERMS,
      intentId: 1,
      announced: false,
      announcementPending: true,
      announcementMessageId: undefined,
    });
    // 人数无从追认，公告文案不得伪造一个数字（effect 不带 joinCount）。
    expect(active.effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: false },
      { kind: "beginLockdownAnnouncement" },
      { kind: "scheduleRestore", delayMs: 60_000 },
    ]);
    expect(transitionLockdown(active.next, {
      type: "announcementResult",
      ok: true,
      messageId: ANNOUNCEMENT_MESSAGE_ID,
    }).next).toEqual({
      kind: "active",
      originalPermissions: PERMS,
      intentId: 1,
      ...ANNOUNCED,
    });
  });

  test("接管正在收尾的 RESTORING → 不补公告（马上就要解除，前言不搭后语）", () => {
    const restoring = transitionLockdown(undefined, {
      type: "adopt", phase: "restoring", intentId: 8, originalPermissions: PERMS, announced: false, remainingMs: 0,
    });
    expect(restoring.effects.map((effect) => effect.kind))
      .toEqual(["prefetchAdmins", "beginRestore"]);
  });

  test("剩余时长恰好算出 0（崩溃期间已经过期）→ 立即安排恢复，不无谓多等", () => {
    const { effects } = transitionLockdown(undefined, {
      type: "adopt", phase: "active", intentId: 1, originalPermissions: PERMS, announced: true, remainingMs: 0,
    });
    expect(effects).toEqual([
      { kind: "prefetchAdmins", onlyIfCold: false },
      { kind: "scheduleRestore", delayMs: 0 },
    ]);
  });

  test("已有记录时 adopt 幂等跳过", () => {
    const state: LockdownState = ACTIVE;
    const { next, effects } = transitionLockdown(state, {
      type: "adopt", phase: "active", intentId: 9, originalPermissions: {}, announced: true, remainingMs: LOCKDOWN_MS,
    });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  test("恢复 applying/restoring intent 时立即幂等对账", () => {
    const applying = transitionLockdown(undefined, {
      type: "adopt",
      phase: "applying",
      intentId: 7,
      originalPermissions: PERMS,
      announced: true,
      announcementMessageId: ANNOUNCEMENT_MESSAGE_ID,
      remainingMs: 0,
    });
    expect(applying.next).toEqual({
      kind: "applying",
      stage: "prepared",
      originalPermissions: PERMS,
      intentId: 7,
      // 这一路立刻发 commitApply，随之置位，补发公告带来的落盘回执不会再写一次。
      commitStarted: true,
      ...ANNOUNCED,
    });
    expect(applying.effects.map((effect) => effect.kind)).toEqual(["prefetchAdmins", "commitApply"]);

    const restoring = transitionLockdown(undefined, {
      type: "adopt", phase: "restoring", intentId: 8, originalPermissions: PERMS, announced: false, remainingMs: 0,
    });
    expect(restoring.next).toEqual({
      kind: "restoring",
      originalPermissions: PERMS,
      intentId: 8,
      restoreAfterPersist: false,
      ...SILENT,
    });
    expect(restoring.effects.map((effect) => effect.kind)).toEqual(["prefetchAdmins", "beginRestore"]);
  });

  test("Worker 重建接到尚未落盘的 intent 时只接管状态，精确回执后才执行权限副作用", () => {
    const applying = transitionLockdown(undefined, {
      type: "adopt", phase: "applying", intentId: 7, originalPermissions: PERMS, announced: false, remainingMs: 0, persisted: false,
    });
    // 落盘说这一轮还没公告过，锁定却仍要继续：补一次公告，权限副作用照样等回执。
    expect(applying.effects.map((effect) => effect.kind))
      .toEqual(["prefetchAdmins", "beginLockdownAnnouncement"]);
    expect(transitionLockdown(applying.next, {
      type: "statePersisted", phase: "applying", intentId: 7,
    }).effects.map((effect) => effect.kind)).toEqual(["commitApply"]);

    const restoring = transitionLockdown(undefined, {
      type: "adopt", phase: "restoring", intentId: 8, originalPermissions: PERMS, announced: false, remainingMs: 0, persisted: false,
    });
    expect(restoring.effects.map((effect) => effect.kind)).toEqual(["prefetchAdmins"]);
    expect(transitionLockdown(restoring.next, {
      type: "statePersisted", phase: "restoring", intentId: 8,
    }).effects.map((effect) => effect.kind)).toEqual(["beginRestore"]);
  });
});
