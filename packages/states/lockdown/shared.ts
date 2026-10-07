import { LOCKDOWN_RETRIGGER_COOLDOWN_MS, NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
import type {
  LockdownAbandonReason,
  LockdownAnnouncement,
  LockdownEffect,
  LockdownState,
} from "../../types/states/lockdown";

/** 本轮公告的记账原样带到下一阶段。 */
export function announcementOf(state: LockdownState): LockdownAnnouncement {
  return {
    announced: state.announced,
    announcementPending: state.announcementPending,
    announcementMessageId: state.announcementMessageId,
  };
}

/** 本轮结束时撤掉群里那条封锁公告；ID 未知（没发成功或还在途）就不删。 */
export function announcementCleanupEffects(state: LockdownState): readonly LockdownEffect[] {
  return state.announcementMessageId === undefined
    ? NO_LOCKDOWN_EFFECTS
    : [{ kind: "deleteLockdownAnnouncement", messageId: state.announcementMessageId }];
}

/** 本轮作废时压制重触发；只在真正作废的那条转移里发出，迟到或重复的失败通知对已换代的状态不发。 */
export function suppressRetrigger(reason: LockdownAbandonReason): LockdownEffect {
  return { kind: "suppressRetrigger", reason, durationMs: LOCKDOWN_RETRIGGER_COOLDOWN_MS };
}

/** APPLYING 的 preparing 阶段还没有 intent，主线程无从落盘（见 publishLockdownState）。 */
export function isPersistable(state: LockdownState): boolean {
  return state.kind !== "applying" || state.stage === "prepared";
}
