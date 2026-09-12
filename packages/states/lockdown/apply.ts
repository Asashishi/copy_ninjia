import { LOCKDOWN_MS } from "../../consts/antiRaid/lockdown";
import {
  announcementCleanupEffects,
  announcementOf,
  suppressRetrigger,
} from "./shared";
import type {
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";

/** 入群数越过反刷群阈值：首次同步占位并发公告，已在轮内只预热管理员表。 */
export function handleThresholdExceeded(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "thresholdExceeded" }>
): LockdownTransition {
  if (state === undefined) {
    return {
      next: {
        kind: "applying",
        stage: "preparing",
        announced: false,
        announcementPending: true,
        announcementMessageId: undefined,
      },
      effects: [
        { kind: "prefetchAdmins", onlyIfCold: true },
        // 公告排在读权限之前：从这一刻起入群就会被请出去，群里不能没有交代。
        { kind: "beginLockdownAnnouncement", joinCount: event.joinCount },
        { kind: "prepareApply", joinCount: event.joinCount },
      ],
    };
  }
  // 本轮状态与恢复意图保持不变，恢复成功后由 owner 清空入群窗口。
  // 生命周期约束见 docs/cn/04-invariants.md。
  return { next: state, effects: [{ kind: "prefetchAdmins", onlyIfCold: true }] };
}

/** 原权限读取完成：形成本轮 intent 并落盘，落盘回执才允许改 Telegram。 */
export function handleApplyPrepared(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "applyPrepared" }>
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "preparing") {
    return { next: state, effects: [] };
  }
  return {
    next: {
      kind: "applying",
      stage: "prepared",
      originalPermissions: event.originalPermissions,
      joinCount: event.joinCount,
      intentId: event.intentId,
      commitStarted: false,
      ...announcementOf(state),
    },
    effects: [{ kind: "persistState" }],
  };
}

/** 读原权限失败：从未形成 intent、也从未改过 Telegram，撤销占位。 */
export function handleApplyPreparationFailed(
  state: LockdownState | undefined
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "preparing") {
    return { next: state, effects: [] };
  }
  // 从未形成 intent、也从未改过 Telegram：撤销占位，并撤掉刚发出去的公告。
  return {
    next: undefined,
    effects: [...announcementCleanupEffects(state), suppressRetrigger("preparationFailed")],
  };
}

/** intent 已落盘但提交前置失败：删除 owner，不走恢复路径。 */
export function handleApplyCommitPreparationFailed(
  state: LockdownState | undefined
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "prepared") {
    return { next: state, effects: [] };
  }
  // applying intent 已经落盘，但 Telegram 写操作尚未开始；删除 owner 即可，
  // 不能走恢复路径，否则可能用 T0 快照覆盖管理员刚改过的 invite 权限。
  return {
    next: undefined,
    effects: [
      { kind: "reportUnlock" },
      ...announcementCleanupEffects(state),
      suppressRetrigger("commitPreparationFailed"),
    ],
  };
}

/** setChatPermissions 结果：成功进 ACTIVE 并定死恢复时刻，失败补一次恢复对账。 */
export function handleApplyResult(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "applyResult" }>
): LockdownTransition {
  if (state?.kind !== "applying" || state.stage !== "prepared") {
    return { next: state, effects: [] };
  }
  if (!event.ok) {
    // 写操作结果不确定（可能已经生效），补一次恢复对账。公告在 APPLYING
    // 就发过了，因此记账原样带走：恢复成功时该不该发解锁公告由它决定。
    return {
      next: {
        kind: "restoring",
        originalPermissions: state.originalPermissions,
        intentId: event.restoreIntentId,
        restoreAfterPersist: true,
        ...announcementOf(state),
      },
      effects: [{ kind: "persistState" }],
    };
  }
  return {
    next: {
      kind: "active",
      originalPermissions: state.originalPermissions,
      intentId: state.intentId,
      ...announcementOf(state),
    },
    effects: [
      { kind: "scheduleRestore", delayMs: LOCKDOWN_MS },
      { kind: "persistState" },
    ],
  };
}
