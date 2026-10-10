import { NO_VERIFICATION_EFFECTS } from "../../consts/antiRaid/verification";
import type {
  ExpelNoticeKind,
  TimeoutInviterVerdictEvent,
  VerificationEffect,
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";
import { exemptOf, expellingOf, isTerminalVerificationPhase, kickedOf, remindersOf } from "./shared";

/** 处理拉人者终核结果，管理员豁免，否则切换到可重放处置终态。 */
export function handleTimeoutInviterVerdict(
  state: VerificationState | undefined,
  event: TimeoutInviterVerdictEvent
): VerificationTransition {
  if (state?.kind !== "checkingInviter") return { next: state, effects: NO_VERIFICATION_EFFECTS };
  if (!event.inviterIsAdmin) {
    return {
      next: expellingOf("timeout", state.snapshot),
      effects: NO_VERIFICATION_EFFECTS,
    };
  }
  const effects: VerificationEffect[] = [
    remindersOf(state.snapshot),
    { kind: "retractJoinCount", joinedAt: state.snapshot.joinedAt },
  ];
  return { next: exemptOf(state.snapshot.label, state.snapshot.isBot), effects };
}

/** 落盘回执到达后打开终态本地执行门；重复回执保持幂等。 */
export function handleTerminalPersisted(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "kickPending") {
    if (state.effectStarted === true) return { next: state, effects: NO_VERIFICATION_EFFECTS };
    state.effectStarted = true;
    const effects: VerificationEffect[] = [];
    if (state.announcementMessageId !== undefined) {
      effects.push({ kind: "deleteMessage", messageId: state.announcementMessageId });
    }
    effects.push({ kind: "kickMember" });
    return { next: state, effects };
  }
  if (state?.kind === "checkingInviter") {
    if (state.executionStarted === true) return { next: state, effects: NO_VERIFICATION_EFFECTS };
    state.executionStarted = true;
    return {
      next: state,
      effects: [{
        kind: "recheckInviter",
        inviterId: state.inviterId,
        snapshot: state.snapshot,
      }],
    };
  }
  if (state?.kind === "expelling") {
    if (state.executionStarted === true) return { next: state, effects: NO_VERIFICATION_EFFECTS };
    state.executionStarted = true;
    return {
      next: state,
      effects: [{
        kind: state.reason === "flood" ? "expelFlood" : "expel",
        snapshot: state.snapshot,
      }],
    };
  }
  return { next: state, effects: NO_VERIFICATION_EFFECTS };
}

/**
 * 本进程执行预算耗尽或当前执行许可无法确认时卸载终态，保留最后一份磁盘快照。
 *
 * 该转移不表示处置成功：解释器据 retainPersistedSnapshot 跳过 tombstone，下一次
 * 完整进程启动仍从持久化记录恢复。非终态收到迟到事件时保持原状态。
 */
export function handleTerminalAttemptBudgetExhausted(
  state: VerificationState | undefined
): VerificationTransition {
  if (!isTerminalVerificationPhase(state?.kind)) {
    return { next: state, effects: NO_VERIFICATION_EFFECTS };
  }
  return {
    next: undefined,
    effects: NO_VERIFICATION_EFFECTS,
    retainPersistedSnapshot: true,
  };
}

/** 处置成功后只允许当前 expelling 终态退出。 */
export function handleExpelSettled(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "expelling") return { next: undefined, effects: NO_VERIFICATION_EFFECTS };
  return { next: state, effects: NO_VERIFICATION_EFFECTS };
}

/** 驱逐播报发出后置位对应标记；只作用于当前 expelling 终态，快照随之重发。 */
export function handleExpelNoticeSent(
  state: VerificationState | undefined,
  notice: ExpelNoticeKind
): VerificationTransition {
  if (state?.kind !== "expelling") return { next: state, effects: NO_VERIFICATION_EFFECTS };
  if (notice === "success") state.successNoticeSent = true;
  else if (notice === "failure") state.failureNoticeSent = true;
  else state.unconfirmedNoticeSent = true;
  return { next: state, effects: NO_VERIFICATION_EFFECTS, snapshotChanged: true };
}

/** 踢人确认成功但成功播报没发出：记下 removalConfirmed；只作用于当前 expelling 终态，已记过时不重发快照。 */
export function handleRemovalConfirmed(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind !== "expelling" || state.removalConfirmed === true) {
    return { next: state, effects: NO_VERIFICATION_EFFECTS };
  }
  state.removalConfirmed = true;
  return { next: state, effects: NO_VERIFICATION_EFFECTS, snapshotChanged: true };
}

/** 私密模式踢人失败后的重试只对尚未执行的原 token 生效。 */
export function handleKickRetry(
  state: VerificationState | undefined
): VerificationTransition {
  if (
    state?.kind !== "kickPending" ||
    state.executionStarted === true ||
    state.effectStarted === true
  ) {
    return { next: state, effects: NO_VERIFICATION_EFFECTS };
  }
  state.effectStarted = true;
  return { next: state, effects: [{ kind: "kickMember" }] };
}

/** 私密模式踢人请求结算后进入双路投递去重窗口。 */
export function handleKickSettled(
  state: VerificationState | undefined,
  now: number
): VerificationTransition {
  if (state?.kind !== "kickPending") return { next: state, effects: NO_VERIFICATION_EFFECTS };
  return { next: kickedOf(state.label, state.isBot, now), effects: NO_VERIFICATION_EFFECTS };
}

/** 只清除短期去重占位，不影响真实验证或可恢复终态。 */
export function handleDedupeExpired(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "exempt" || state?.kind === "kicked") {
    return { next: undefined, effects: NO_VERIFICATION_EFFECTS };
  }
  return { next: state, effects: NO_VERIFICATION_EFFECTS };
}
