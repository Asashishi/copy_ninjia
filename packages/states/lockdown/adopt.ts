import { NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
import type {
  LockdownAnnouncement,
  LockdownEffect,
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";

/** 重启接管一条落盘下来的私密模式记录；已有内存状态时原样保留，不重复接管。 */
export function handleAdopt(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "adopt" }>
): LockdownTransition {
  if (state !== undefined) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  // 接管方只认落盘下来的 announced 与 messageId：落盘记为未公告且锁定仍要继续时
  // 补一次公告；RESTORING 阶段不补公告。
  const announceOnAdopt: boolean = !event.announced && event.phase !== "restoring";
  const announcement: LockdownAnnouncement = {
    announced: event.announced,
    announcementPending: announceOnAdopt,
    announcementMessageId: event.announcementMessageId,
  };
  const announceEffects: LockdownEffect[] = announceOnAdopt
    ? [{ kind: "beginLockdownAnnouncement" }]
    : [];
  if (event.phase === "applying") {
    return {
      next: {
        kind: "applying",
        stage: "prepared",
        originalPermissions: event.originalPermissions,
        intentId: event.intentId,
        // persisted 时下面立刻发 commitApply，commitStarted 同步置位。
        commitStarted: event.persisted,
        ...announcement,
      },
      effects: [
        { kind: "prefetchAdmins", onlyIfCold: false },
        ...announceEffects,
        ...(!event.persisted
          ? []
          : [{ kind: "commitApply" } as const]),
      ],
    };
  }
  if (event.phase === "restoring") {
    return {
      next: {
        kind: "restoring",
        originalPermissions: event.originalPermissions,
        intentId: event.intentId,
        restoreAfterPersist: !event.persisted,
        ...announcement,
      },
      effects: [
        { kind: "prefetchAdmins", onlyIfCold: false },
        ...(!event.persisted
          ? []
          : [{ kind: "beginRestore", originalPermissions: event.originalPermissions } as const]),
      ],
    };
  }
  if (event.phase === "reconciling") {
    return {
      next: {
        kind: "reconciling",
        originalPermissions: event.originalPermissions,
        intentId: event.intentId,
        reapplyAfterPersist: !event.persisted,
        ...announcement,
      },
      effects: [
        { kind: "prefetchAdmins", onlyIfCold: false },
        ...announceEffects,
        { kind: "scheduleRestore", delayMs: event.remainingMs },
        ...(!event.persisted
          ? []
          : [{ kind: "beginReapply" } as const]),
      ],
    };
  }
  return {
    next: {
      kind: "active",
      originalPermissions: event.originalPermissions,
      intentId: event.intentId,
      ...announcement,
    },
    effects: [
      { kind: "prefetchAdmins", onlyIfCold: false },
      ...announceEffects,
      { kind: "scheduleRestore", delayMs: event.remainingMs },
    ],
  };
}
