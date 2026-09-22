import { verificationGeneration } from
  "../../cache/workers/antiRaid/verification";
import type {
  VerificationSnapshot,
  PendingVerificationSnapshot,
} from "../../types/antiRaid/verification";
import type {
  ExpelSnapshot,
  KickPendingState,
  PendingState,
  VerificationState,
  VerificationTerminalState,
} from "../../types/states/verification";
import { isTerminalVerificationPhase } from "../../states/verification/shared";

/** 需要跨 Worker 重建持久化的验证阶段。 */
type PersistedVerificationState =
  | PendingState
  | KickPendingState
  | VerificationTerminalState;

/** 当前状态是否拥有持久化快照。 */
export function isPersistedVerificationState(
  state: VerificationState | undefined
): state is PersistedVerificationState {
  return state?.kind === "pending" || isTerminalVerificationPhase(state?.kind);
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
  // kickPending 自带身份与入群时刻；其余阶段取 pending 本身或终态冻结的语义快照。
  let label: string;
  let isBot: boolean;
  let announcementMessageId: number | undefined;
  let reminderMessageId: number | undefined;
  let replyReminderMessageId: number | undefined;
  let joinedAt: number;
  let expiresAt: number;
  if (state.kind === "kickPending") {
    label = state.label;
    isBot = state.isBot;
    announcementMessageId = state.announcementMessageId;
    reminderMessageId = undefined;
    replyReminderMessageId = undefined;
    joinedAt = state.requestedAt;
    expiresAt = state.requestedAt;
  } else {
    const source: PendingState | ExpelSnapshot = state.kind === "pending" ? state : state.snapshot;
    label = source.label;
    isBot = source.isBot;
    announcementMessageId = source.announcementMessageId;
    reminderMessageId = source.reminderMessageId;
    replyReminderMessageId = source.replyReminderMessageId;
    joinedAt = source.joinedAt;
    expiresAt = source.expiresAt;
  }
  const base: PendingVerificationSnapshot = {
    chatId,
    userId,
    generation: verificationGeneration.current,
    revision,
    label,
    isBot,
    announcementMessageId,
    trackedMessageTimes:
      state.kind === "pending" ? [...state.trackedMessageTimes] : [],
    invitedBy: state.kind === "pending" ? state.invitedBy : undefined,
    reminderMessageId,
    replyReminderMessageId,
    replyReminderRequested:
      state.kind === "pending" ? state.replyReminderRequested : false,
    welcomeAnchorMessageId:
      state.kind === "pending" ? state.welcomeAnchorMessageId : undefined,
    reminderSuperseded:
      state.kind === "pending" ? state.reminderSuperseded : true,
    joinedAt,
    expiresAt,
    phase: "pending",
  };
  if (state.kind === "pending") return base;
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
