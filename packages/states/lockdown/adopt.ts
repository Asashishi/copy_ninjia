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
  if (state !== undefined) return { next: state, effects: [] };
  // 上一代那次发送的结局已无从追认：接管方只认落盘下来的 announced 与
  // messageId。落盘说「没公告过」而锁定仍要继续时补一次公告——群里必须
  // 知道自己为什么进不来人；RESTORING 正在收尾，补公告只会前言不搭后语。
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
        // 下面立刻发 commitApply 的那一路必须同时置位，否则补发公告带来的
        // 那次落盘回执会让同一轮再写一次 Telegram。
        commitStarted: event.persisted !== false,
        ...announcement,
      },
      effects: [
        { kind: "prefetchAdmins", onlyIfCold: false },
        ...announceEffects,
        ...(event.persisted === false
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
        restoreAfterPersist: event.persisted === false,
        ...announcement,
      },
      effects: [
        { kind: "prefetchAdmins", onlyIfCold: false },
        ...(event.persisted === false
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
        reapplyAfterPersist: event.persisted === false,
        ...announcement,
      },
      effects: [
        { kind: "prefetchAdmins", onlyIfCold: false },
        ...announceEffects,
        { kind: "scheduleRestore", delayMs: event.remainingMs },
        ...(event.persisted === false
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
