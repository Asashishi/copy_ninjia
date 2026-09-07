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
      // 迟到的旧恢复尝试成功了：真实权限刚被这次旧尝试恢复成「未限制」，
      // 但新峰值已经要求继续锁定（见 docs/cn/04-invariants.md）——原地补一次限制，
      // 先把「远端现在已开放、需要重新收紧」持久化；落盘回执后才执行纠偏，
      // Worker 或进程在两步之间崩溃也能从 RECONCILING 幂等接上。
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
    // 这次失败回执对应的是旧的恢复尝试：它在途期间新峰值已把状态从
    // RESTORING 推回 ACTIVE/RECONCILING 并给满新倒计时（见 thresholdExceeded）。
    // 权限现在按锁定意图仍应保持限制，忽略这条迟到的失败——
    // 不打断刚延长的倒计时，到期后会自然重新发起一次恢复。
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
