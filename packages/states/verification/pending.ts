import { ANTI_RAID_PER_MINUTE_LIMIT, JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import {
  VERIFICATION_REMINDER_UNDELIVERED_MAX_MS,
  VERIFICATION_TIMEOUT_MS,
} from "../../consts/antiRaid/verification";
import { trimSlidingWindowArray } from "../../libs/slidingWindowRateLimit";
import type {
  ConfirmedThreadCommentEvent,
  ExpelSnapshot,
  ReminderLandedEvent,
  TrackedMessageEvent,
  VerificationCallbackEvent,
  VerificationEffect,
  VerificationState,
  VerificationTransition,
  VerifyTimeoutEvent,
} from "../../types/states/verification";
import { pendingUpdated, remindersOf, snapshotOf } from "./shared";

/** 处理待验证成员发言、评论区豁免与刷屏终态切换。 */
export function handleTrackedMessage(
  state: VerificationState | undefined,
  event: TrackedMessageEvent
): VerificationTransition {
  if (state?.kind !== "pending") return { next: state, effects: [] };

  if (event.inCommentThread) {
    return {
      next: { kind: "exempt", label: state.label, isBot: state.isBot },
      effects: [
        remindersOf(state),
        { kind: "retractJoinCount", joinedAt: state.joinedAt },
        {
          kind: "sendWelcome",
          variant: "channelComment",
          targetLabel: state.label,
          anchorMessageId: event.messageId,
        },
      ],
    };
  }

  // 频道评论区活动已提前豁免；其余消息按成员自己的滑动窗口统计。
  state.trackedMessageTimes = trimSlidingWindowArray({
    timestamps: state.trackedMessageTimes,
    windowMs: JOIN_WINDOW_MS,
    now: event.now,
  });
  state.trackedMessageTimes.push(event.now);
  if (state.trackedMessageTimes.length > ANTI_RAID_PER_MINUTE_LIMIT) {
    return {
      next: { kind: "expelling", reason: "flood", snapshot: snapshotOf(state) },
      effects: [],
    };
  }
  // 滑动窗口本身是持久字段，即使提醒已补发，也必须发布本次原地修改。
  if (state.replyReminderRequested) return pendingUpdated(state, []);
  state.replyReminderRequested = true;
  state.welcomeAnchorMessageId = event.messageId;
  state.reminderSuperseded = true;

  const effects: VerificationEffect[] = [{
    kind: "sendReplyReminder",
    label: state.label,
    targetMessageId: event.messageId,
  }];
  // 先发补充提醒再删旧提醒，避免 deleteMessage 的 await 扩大交错窗口。
  if (state.reminderMessageId !== undefined) {
    effects.push({ kind: "deleteMessage", messageId: state.reminderMessageId });
    state.reminderMessageId = undefined;
  }
  return pendingUpdated(state, effects);
}

/** 处理冷缓存核查返回的权威评论区确认。 */
export function handleConfirmedThreadComment(
  state: VerificationState | undefined,
  event: ConfirmedThreadCommentEvent
): VerificationTransition {
  if (state?.kind === "pending") {
    return handleTrackedMessage(state, {
      type: "trackedMessage",
      messageId: event.messageId,
      inCommentThread: true,
      now: event.now,
    });
  }
  if (
    state?.kind !== "expelling" ||
    state.reason !== "flood" ||
    state.executionStarted === true ||
    !event.allowFloodTerminalExemption
  ) {
    return { next: state, effects: [] };
  }
  const snapshot: ExpelSnapshot = state.snapshot;
  return {
    next: { kind: "exempt", label: snapshot.label, isBot: snapshot.isBot },
    effects: [
      remindersOf(snapshot),
      { kind: "retractJoinCount", joinedAt: snapshot.joinedAt },
      {
        kind: "sendWelcome",
        variant: "channelComment",
        targetLabel: snapshot.label,
        anchorMessageId: event.messageId,
      },
    ],
  };
}

/**
 * 「通过」按钮的驳回理由；undefined 表示放行。本人不能靠它自验，
 * 代点资格没查出来时只应答「稍后再试」。
 */
function approveDenial(
  event: VerificationCallbackEvent
): "useSelfButton" | "notApprover" | "approverUnknown" | undefined {
  if (event.isSelf) return "useSelfButton";
  if (event.fromCanApprove === undefined) return "approverUnknown";
  return event.fromCanApprove ? undefined : "notApprover";
}

/**
 * 处理两颗验证按钮：「我是良民」只认待验证真人本人，「通过」只认本群管理员
 * 的代点。记录不在 pending 时先应答失效，不泄漏也不改变任何状态。
 */
export function handleCallback(
  state: VerificationState | undefined,
  event: VerificationCallbackEvent
): VerificationTransition {
  if (state?.kind !== "pending") {
    return {
      next: state,
      effects: [{ kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: "invalid" }],
    };
  }

  const denial: "notYourButton" | "useSelfButton" | "notApprover" | "approverUnknown" | undefined =
    event.action === "self"
      ? (event.isSelf ? undefined : "notYourButton")
      : approveDenial(event);
  if (denial !== undefined) {
    return {
      next: state,
      effects: [{ kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: denial }],
    };
  }

  return {
    next: undefined,
    effects: [
      { kind: "answerCallback", callbackQueryId: event.callbackQueryId, reply: "ok" },
      remindersOf(state),
      {
        kind: "sendWelcome",
        variant: event.action === "self"
          ? "verified"
          : state.isBot ? "vouchedBot" : "approved",
        targetLabel: state.label,
        fromLabel: event.fromLabel,
        anchorMessageId: state.welcomeAnchorMessageId,
      },
    ],
  };
}

/** 处理验证到期；不可见提醒先续期，已可见提醒进入可恢复终态。 */
export function handleVerifyTimeout(
  state: VerificationState | undefined,
  event: VerifyTimeoutEvent
): VerificationTransition {
  if (state?.kind !== "pending") return { next: state, effects: [] };

  if (
    state.reminderMessageId === undefined &&
    state.replyReminderMessageId === undefined &&
    event.now - state.joinedAt < VERIFICATION_REMINDER_UNDELIVERED_MAX_MS
  ) {
    state.expiresAt = event.now + VERIFICATION_TIMEOUT_MS;
    const canReply: boolean =
      state.replyReminderRequested && state.welcomeAnchorMessageId !== undefined;
    if (!canReply) {
      state.replyReminderRequested = false;
      state.reminderSuperseded = false;
    }
    const effects: VerificationEffect[] = canReply
      ? [{
        kind: "sendReplyReminder",
        label: state.label,
        targetMessageId: state.welcomeAnchorMessageId!,
      }]
      : [{ kind: "sendReminder", label: state.label, isBot: state.isBot }];
    return pendingUpdated(state, effects, true);
  }

  const snapshot: ExpelSnapshot = snapshotOf(state);
  if (state.invitedBy !== undefined) {
    return {
      next: { kind: "checkingInviter", inviterId: state.invitedBy, snapshot },
      effects: [],
    };
  }
  return { next: { kind: "expelling", reason: "timeout", snapshot }, effects: [] };
}

/** 回填真正落地的提醒，并从按钮可见时重新给满验证窗口。 */
export function handleReminderLanded(
  state: VerificationState | undefined,
  event: ReminderLandedEvent
): VerificationTransition {
  if (state?.kind !== "pending") {
    return { next: state, effects: [{ kind: "deleteMessage", messageId: event.messageId }] };
  }
  if (event.reminderKind === "original" && state.reminderSuperseded) {
    return { next: state, effects: [{ kind: "deleteMessage", messageId: event.messageId }] };
  }
  if (event.reminderKind === "original") state.reminderMessageId = event.messageId;
  else state.replyReminderMessageId = event.messageId;
  state.expiresAt = event.now + VERIFICATION_TIMEOUT_MS;
  return pendingUpdated(state, [], true);
}
