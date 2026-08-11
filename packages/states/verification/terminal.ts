import type {
  TimeoutInviterVerdictEvent,
  VerificationEffect,
  VerificationState,
  VerificationTransition,
} from "../../types/states/verification";
import { remindersOf } from "./shared";

/** 处理拉人者终核结果，管理员豁免，否则切换到可重放处置终态。 */
export function handleTimeoutInviterVerdict(
  state: VerificationState | undefined,
  event: TimeoutInviterVerdictEvent
): VerificationTransition {
  if (state?.kind !== "checkingInviter") return { next: state, effects: [] };
  if (!event.inviterIsAdmin) {
    return {
      next: { kind: "expelling", reason: "timeout", snapshot: state.snapshot },
      effects: [],
    };
  }
  const effects: VerificationEffect[] = [
    remindersOf(state.snapshot),
    { kind: "retractJoinCount", joinedAt: state.snapshot.joinedAt },
  ];
  return {
    next: {
      kind: "exempt",
      label: state.snapshot.label,
      isBot: state.snapshot.isBot,
    },
    effects,
  };
}

/** 落盘回执到达后打开终态本地执行门；重复回执保持幂等。 */
export function handleTerminalPersisted(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "kickPending") {
    if (state.effectStarted === true) return { next: state, effects: [] };
    state.effectStarted = true;
    const effects: VerificationEffect[] = [];
    if (state.announcementMessageId !== undefined) {
      effects.push({ kind: "deleteMessage", messageId: state.announcementMessageId });
    }
    effects.push({ kind: "kickMember" });
    return { next: state, effects };
  }
  if (state?.kind === "checkingInviter") {
    if (state.executionStarted === true) return { next: state, effects: [] };
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
    if (state.executionStarted === true) return { next: state, effects: [] };
    state.executionStarted = true;
    return {
      next: state,
      effects: [{
        kind: state.reason === "flood" ? "expelFlood" : "expel",
        snapshot: state.snapshot,
      }],
    };
  }
  return { next: state, effects: [] };
}

/**
 * 本进程执行预算耗尽后卸载终态，但明确保留最后一份磁盘快照。
 *
 * 这不是处置成功：解释器必须据 retainPersistedSnapshot 跳过 tombstone，下一次
 * 完整进程启动仍会从持久化记录恢复。非终态收到迟到事件时保持原状态。
 */
export function handleTerminalAttemptBudgetExhausted(
  state: VerificationState | undefined
): VerificationTransition {
  if (
    state?.kind !== "kickPending" &&
    state?.kind !== "checkingInviter" &&
    state?.kind !== "expelling"
  ) {
    return { next: state, effects: [] };
  }
  return {
    next: undefined,
    effects: [],
    retainPersistedSnapshot: true,
  };
}

/** 处置成功后只允许当前 expelling 终态退出。 */
export function handleExpelSettled(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "expelling") return { next: undefined, effects: [] };
  return { next: state, effects: [] };
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
    return { next: state, effects: [] };
  }
  state.effectStarted = true;
  return { next: state, effects: [{ kind: "kickMember" }] };
}

/** 私密模式踢人请求结算后进入双路投递去重窗口。 */
export function handleKickSettled(
  state: VerificationState | undefined,
  now: number
): VerificationTransition {
  if (state?.kind !== "kickPending") return { next: state, effects: [] };
  return {
    next: {
      kind: "kicked",
      label: state.label,
      isBot: state.isBot,
      kickedAt: now,
    },
    effects: [],
  };
}

/** 只清除短期去重占位，不影响真实验证或可恢复终态。 */
export function handleDedupeExpired(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind === "exempt" || state?.kind === "kicked") {
    return { next: undefined, effects: [] };
  }
  return { next: state, effects: [] };
}
