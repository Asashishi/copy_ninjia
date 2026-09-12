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

/** 本轮 intent 落盘成功：APPLYING 才允许改 Telegram，其余阶段释放等待中的动作。 */
export function handleStatePersisted(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "statePersisted" }>
): LockdownTransition {
  if (state?.kind !== event.phase) return { next: state, effects: [] };
  if (state.kind === "applying") {
    if (
      state.stage !== "prepared" ||
      state.intentId !== event.intentId ||
      // 公告落盘与主线程对账可重复确认同一 intent，提交仅派发一次。
      state.commitStarted
    ) {
      return { next: state, effects: [] };
    }
    return { next: { ...state, commitStarted: true }, effects: [{ kind: "commitApply" }] };
  }
  if (state.intentId !== event.intentId) return { next: state, effects: [] };
  if (state.kind === "restoring" && state.restoreAfterPersist) {
    return {
      next: { ...state, restoreAfterPersist: false },
      effects: [{ kind: "beginRestore", originalPermissions: state.originalPermissions }],
    };
  }
  if (state.kind === "reconciling" && state.reapplyAfterPersist) {
    return {
      next: { ...state, reapplyAfterPersist: false },
      effects: [{ kind: "beginReapply" }],
    };
  }
  return { next: state, effects: [] };
}

/**
 * 本轮 intent 确定写不进 SQLite：一律 fail-safe 打开。
 * 提交未派发时撤销占位；可能在途或已生效的限制立刻恢复，不再等落盘回执。
 */
export function handlePersistFailed(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "persistFailed" }>
): LockdownTransition {
  if (state?.kind !== event.phase) return { next: state, effects: [] };
  if (state.kind === "applying") {
    if (state.stage !== "prepared" || state.intentId !== event.intentId) {
      return { next: state, effects: [] };
    }
    if (!state.commitStarted) {
      return {
        next: undefined,
        effects: [
          { kind: "reportUnlock" },
          ...announcementCleanupEffects(state),
          suppressRetrigger("persistFailed"),
        ],
      };
    }
  }
  if (!("intentId" in state) || state.intentId !== event.intentId) return { next: state, effects: [] };
  if (state.kind === "restoring") {
    // 本来就等着落盘回执去恢复：回执永远不会来了，直接恢复。
    if (!state.restoreAfterPersist) return { next: state, effects: [] };
    return {
      next: { ...state, restoreAfterPersist: false },
      effects: [
        { kind: "beginRestore", originalPermissions: state.originalPermissions },
        suppressRetrigger("persistFailed"),
      ],
    };
  }
  // 已派发的提交可能在途；恢复沿同一 API 串行链排在提交后面。
  return {
    next: {
      kind: "restoring",
      originalPermissions: state.originalPermissions,
      intentId: state.intentId,
      restoreAfterPersist: false,
      ...announcementOf(state),
    },
    effects: [
      { kind: "persistState" },
      { kind: "beginRestore", originalPermissions: state.originalPermissions },
      suppressRetrigger("persistFailed"),
    ],
  };
}
