import { verificationGeneration } from
  "../../cache/workers/antiRaid/verification";
import type {
  VerificationSnapshot,
  VerificationSnapshotBase,
} from "../../types/antiRaid/verification";
import type {
  ExpelSnapshot,
  KickPendingState,
  PendingState,
  VerificationState,
  VerificationTerminalState,
} from "../../types/states/verification";

/** 需要跨 Worker 重建持久化的验证阶段。 */
type PersistedVerificationState =
  | PendingState
  | KickPendingState
  | VerificationTerminalState;

/** 当前状态是否拥有持久化快照。 */
export function isPersistedVerificationState(
  state: VerificationState | undefined
): state is PersistedVerificationState {
  return state?.kind === "pending" ||
    state?.kind === "kickPending" ||
    state?.kind === "checkingInviter" ||
    state?.kind === "expelling";
}

interface VerificationSnapshotParams {
  chatId: number;
  userId: number;
  state: PersistedVerificationState;
  revision: number;
}

/** 将当前持久化阶段投影成跨线程严格快照。 */
export function verificationSnapshot({
  chatId,
  userId,
  state,
  revision,
}: VerificationSnapshotParams): VerificationSnapshot {
  const source: PendingState | ExpelSnapshot | undefined =
    state.kind === "pending"
      ? state
      : state.kind === "kickPending"
        ? undefined
        : state.snapshot;
  const base: VerificationSnapshotBase = {
    chatId,
    userId,
    generation: verificationGeneration.current,
    revision,
    label: state.kind === "kickPending" ? state.label : source!.label,
    isBot: state.kind === "kickPending" ? state.isBot : source!.isBot,
    announcementMessageId:
      state.kind === "kickPending"
        ? state.announcementMessageId
        : source!.announcementMessageId,
    trackedMessageTimes:
      state.kind === "pending" ? [...state.trackedMessageTimes] : [],
    invitedBy: state.kind === "pending" ? state.invitedBy : undefined,
    reminderMessageId: source?.reminderMessageId,
    replyReminderMessageId: source?.replyReminderMessageId,
    replyReminderRequested:
      state.kind === "pending" ? state.replyReminderRequested : false,
    welcomeAnchorMessageId:
      state.kind === "pending" ? state.welcomeAnchorMessageId : undefined,
    reminderSuperseded:
      state.kind === "pending" ? state.reminderSuperseded : true,
    joinedAt:
      state.kind === "kickPending" ? state.requestedAt : source!.joinedAt,
    expiresAt:
      state.kind === "kickPending" ? state.requestedAt : source!.expiresAt,
  };
  if (state.kind === "pending") return { ...base, phase: "pending" };
  if (state.kind === "kickPending") {
    return {
      ...base,
      phase: "kickPending",
      requestedAt: state.requestedAt,
      countedJoinAt: state.countedJoinAt,
    };
  }
  if (state.kind === "checkingInviter") {
    return {
      ...base,
      phase: "checkingInviter",
      terminalInviterId: state.inviterId,
    };
  }
  return {
    ...base,
    phase: "expelling",
    expelReason: state.reason,
    successNoticeSent: state.successNoticeSent,
    failureNoticeSent: state.failureNoticeSent,
    unconfirmedNoticeSent: state.unconfirmedNoticeSent,
    removalConfirmed: state.removalConfirmed,
  };
}
