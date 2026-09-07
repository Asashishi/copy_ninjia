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
      // 同一份 intent 的落盘回执可能到达多次（公告结果落盘、主线程对账
      // 重跑），但 commitApply 是一次真实的 setChatPermissions。
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
 * 占位阶段直接撤销，已经落地的限制立刻发起恢复，不再等落盘回执。
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
    // intent 写不进 SQLite，而 Telegram 还没被改过：这一轮当作从未发生。
    return {
      next: undefined,
      effects: [
        { kind: "reportUnlock" },
        ...announcementCleanupEffects(state),
        suppressRetrigger("persistFailed"),
      ],
    };
  }
  if (state.intentId !== event.intentId) return { next: state, effects: [] };
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
  // ACTIVE / RECONCILING：限制已经落在群上，却再也无法跨进程恢复——
  // 立刻恢复原权限，绝不留一条没人能解除的限制（见 docs/cn/04-invariants.md）。
  return {
    next: {
      kind: "restoring",
      originalPermissions: state.originalPermissions,
      intentId: state.intentId,
      restoreAfterPersist: false,
      ...announcementOf(state),
    },
    effects: [
      { kind: "beginRestore", originalPermissions: state.originalPermissions },
      suppressRetrigger("persistFailed"),
    ],
  };
}
