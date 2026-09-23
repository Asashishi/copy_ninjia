import { NO_LOCKDOWN_EFFECTS } from "../../consts/antiRaid/lockdown";
import { isPersistable } from "./shared";
import type {
  LockdownMachineEvent,
  LockdownState,
  LockdownTransition,
} from "../../types/states/lockdown";

/**
 * 封锁公告的发送结果。发送结果比本轮活得更久时（加锁失败、期间被解除），
 * 在拿到 ID 的此刻直接删除，绝不留孤儿公告。
 */
export function handleAnnouncementResult(
  state: LockdownState | undefined,
  event: Extract<LockdownMachineEvent, { type: "announcementResult" }>
): LockdownTransition {
  if (state === undefined) {
    // 本轮在公告落地前就结束了（加锁失败、或期间被解除）：这条消息从此
    // 没有任何状态记得它，只能在拿到 ID 的此刻直接删掉。
    return {
      next: state,
      effects: event.ok && event.messageId !== undefined
        ? [{ kind: "deleteLockdownAnnouncement", messageId: event.messageId }]
        : NO_LOCKDOWN_EFFECTS,
    };
  }
  if (!state.announcementPending) return { next: state, effects: NO_LOCKDOWN_EFFECTS };
  if (!event.ok) return { next: { ...state, announcementPending: false }, effects: NO_LOCKDOWN_EFFECTS };
  const next: LockdownState = {
    ...state,
    announced: true,
    announcementPending: false,
    announcementMessageId: event.messageId,
  };
  return { next, effects: isPersistable(next) ? [{ kind: "persistState" }] : NO_LOCKDOWN_EFFECTS };
}
