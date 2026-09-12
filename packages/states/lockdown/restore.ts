import { RESTORE_RETRY_MS } from "../../consts/antiRaid/lockdown";
import { announcementCleanupEffects, announcementOf } from "./shared";
import type { ChatPermissions } from "grammy/types";
import type {
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";

/** 本轮到期：先落盘「要恢复」，落盘回执后才真的把权限还回去。 */
export function handleRestoreTimerFired(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "restoreTimerFired" }>
): LockdownTransition {
  if (state?.kind !== "active" && state?.kind !== "reconciling") {
    return { next: state, effects: [] };
  }
  return {
    next: {
      kind: "restoring",
      originalPermissions: state.originalPermissions,
      intentId: event.intentId,
      restoreAfterPersist: true,
      ...announcementOf(state),
    },
    effects: [{ kind: "persistState" }],
  };
}

/** 恢复重试计时器到点：状态不变，只再发一次恢复。 */
export function handleRestoreRetryFired(state: LockdownState | undefined): LockdownTransition {
  if (state?.kind !== "restoring") return { next: state, effects: [] };
  return {
    next: state,
    effects: [{ kind: "beginRestore", originalPermissions: state.originalPermissions }],
  };
}

/** 纠偏重试计时器到点：状态不变，只再发一次重新收紧。 */
export function handleReapplyRetryFired(state: LockdownState | undefined): LockdownTransition {
  if (state?.kind !== "reconciling") return { next: state, effects: [] };
  return { next: state, effects: [{ kind: "beginReapply" }] };
}

/** 显式解除：占位阶段直接撤销，其余阶段走与到期恢复同一条落盘优先的路径。 */
export function handleDeactivate(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "deactivate" }>
): LockdownTransition {
  if (state === undefined) return { next: state, effects: [] };
  if (state.kind === "applying" && state.stage === "preparing") {
    // 尚未形成 intent、更没改过 Telegram，直接撤销占位并撤掉公告即可。
    return { next: undefined, effects: announcementCleanupEffects(state) };
  }
  const originalPermissions: ChatPermissions =
    state.originalPermissions;
  return {
    next: {
      kind: "restoring",
      originalPermissions,
      intentId: event.intentId,
      restoreAfterPersist: true,
      ...announcementOf(state),
    },
    effects: [{ kind: "persistState" }],
  };
}

/** 恢复调用结果；迟到回执与新一轮的关系见 docs/cn/04-invariants.md。 */
export function handleRestoreResult(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "restoreResult" }>
): LockdownTransition {
  if (state === undefined || state.kind === "applying") return { next: state, effects: [] };
  if (event.ok) {
    if (state.kind === "active") {
      // ACTIVE 收到恢复成功回执时，先持久化远端权限与当前意图的差异，
      // 再重新收紧；RECONCILING 在 Worker 重建后仍可幂等接管。
      return {
        next: {
          kind: "reconciling",
          originalPermissions: state.originalPermissions,
          intentId: state.intentId,
          reapplyAfterPersist: true,
          ...announcementOf(state),
        },
        effects: [{ kind: "persistState" }],
      };
    }
    if (state.kind === "reconciling") return { next: state, effects: [] };
    return {
      next: undefined,
      effects: state.announced
        ? [
          { kind: "reportUnlock" },
          ...announcementCleanupEffects(state),
          { kind: "announceUnlock" },
        ]
        : [{ kind: "reportUnlock" }, ...announcementCleanupEffects(state)],
    };
  }
  if (state.kind === "active" || state.kind === "reconciling") {
    // 当前意图仍为锁定，迟到的失败回执不改变它的倒计时或纠偏阶段。
    return { next: state, effects: [] };
  }
  return { next: state, effects: [{ kind: "scheduleRestoreRetry", delayMs: RESTORE_RETRY_MS }] };
}

/** 纠偏调用结果：成功回到 ACTIVE 并落盘，失败按有界退避重试。 */
export function handleReapplyResult(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "reapplyResult" }>
): LockdownTransition {
  if (state?.kind !== "reconciling") return { next: state, effects: [] };
  if (!event.ok) {
    return {
      next: state,
      effects: [{ kind: "scheduleReapplyRetry", delayMs: RESTORE_RETRY_MS }],
    };
  }
  return {
    next: {
      kind: "active",
      originalPermissions: state.originalPermissions,
      intentId: state.intentId,
      ...announcementOf(state),
    },
    effects: [{ kind: "persistState" }],
  };
}
