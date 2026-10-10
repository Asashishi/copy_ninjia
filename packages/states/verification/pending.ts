import { ANTI_RAID_PER_MINUTE_LIMIT, JOIN_WINDOW_MS } from "../../consts/antiRaid/lockdown";
import {
  NO_VERIFICATION_EFFECTS,
  VERIFICATION_REMINDER_UNDELIVERED_MAX_MS,
  VERIFICATION_TIMEOUT_MS,
} from "../../consts/antiRaid/verification";
import { trimSlidingWindowArrayInPlace } from "../../libs/slidingWindowRateLimit";
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
import {
  channelCommentExemption,
  checkingInviterOf,
  exemptOf,
  expellingOf,
  pendingUpdated,
  remindersOf,
  snapshotOf,
} from "./shared";

/** 处理待验证成员发言、评论区豁免与刷屏终态切换。 */
export function handleTrackedMessage(
  state: VerificationState | undefined,
  event: TrackedMessageEvent
): VerificationTransition {
  if (state?.kind !== "pending") return { next: state, effects: NO_VERIFICATION_EFFECTS };

  if (event.inCommentThread) return channelCommentExemption(state, event.messageId);

  // 频道评论区活动已提前豁免；其余消息按成员自己的滑动窗口统计。
  //
  // 就地修剪窗口数组：状态机独占这份数组，消费方都以 `[...]` 复制出去，
  // 见 libs/slidingWindowRateLimit.ts 的 trimSlidingWindowArrayInPlace。
  trimSlidingWindowArrayInPlace(state.trackedMessageTimes, JOIN_WINDOW_MS, event.now);
  state.trackedMessageTimes.push(event.now);
  if (state.trackedMessageTimes.length > ANTI_RAID_PER_MINUTE_LIMIT) {
    return {
      next: expellingOf("flood", snapshotOf(state)),
      effects: NO_VERIFICATION_EFFECTS,
    };
  }
  // 滑动窗口是持久字段，提醒已补发时也发布本次原地修改。
  if (state.replyReminderRequested) return pendingUpdated(state, NO_VERIFICATION_EFFECTS);
  state.replyReminderRequested = true;
  state.welcomeAnchorMessageId = event.messageId;
  state.reminderSuperseded = true;

  const effects: VerificationEffect[] = [{
    kind: "sendReplyReminder",
    label: state.label,
    targetMessageId: event.messageId,
  }];
  // 先发补充提醒再删旧提醒。
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
  if (state?.kind === "pending") return channelCommentExemption(state, event.messageId);
  if (
    state?.kind !== "expelling" ||
    state.reason !== "flood" ||
    state.executionStarted === true ||
    !event.allowFloodTerminalExemption
  ) {
    return { next: state, effects: NO_VERIFICATION_EFFECTS };
  }
  return channelCommentExemption(state.snapshot, event.messageId);
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
 * 处理两颗验证按钮：本人验证只认待验证真人本人，「通过」只认本群管理员
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
  if (state?.kind !== "pending") return { next: state, effects: NO_VERIFICATION_EFFECTS };

  if (
    state.reminderMessageId === undefined &&
    state.replyReminderMessageId === undefined &&
    event.now - state.joinedAt < VERIFICATION_REMINDER_UNDELIVERED_MAX_MS
  ) {
    state.expiresAt = event.now + VERIFICATION_TIMEOUT_MS;
    // replyReminderRequested、reminderSuperseded 与锚点同真同假（写入只在 handleTrackedMessage，
    // 落盘恢复由 verificationCodec 校验），有锚点即要求过回复式提醒。
    const anchorMessageId: number | undefined = state.welcomeAnchorMessageId;
    const effects: VerificationEffect[] = anchorMessageId !== undefined
      ? [{
        kind: "sendReplyReminder",
        label: state.label,
        targetMessageId: anchorMessageId,
      }]
      : [{ kind: "sendReminder", label: state.label, isBot: state.isBot }];
    return pendingUpdated(state, effects, true);
  }

  const snapshot: ExpelSnapshot = snapshotOf(state);
  if (state.invitedBy !== undefined) {
    return {
      next: checkingInviterOf(state.invitedBy, snapshot),
      effects: NO_VERIFICATION_EFFECTS,
    };
  }
  return { next: expellingOf("timeout", snapshot), effects: NO_VERIFICATION_EFFECTS };
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
  return pendingUpdated(state, NO_VERIFICATION_EFFECTS, true);
}

/**
 * 处理异步管理员核查返回的通过结论。
 *
 * 只对 pending 生效：结论回来时记录若已不是 pending（按钮已通过、已离群、已进终态），
 * 迟到结论原样放过，不把记录重新拉回 EXEMPT。
 *
 * 通过时删掉两条验证提醒，并撤销这次入群在反刷群滑动窗口里的计数。
 */
export function handleAdminCheckResolved(
  state: VerificationState | undefined
): VerificationTransition {
  if (state?.kind !== "pending") return { next: state, effects: NO_VERIFICATION_EFFECTS };
  return {
    next: exemptOf(state.label, state.isBot),
    effects: [
      remindersOf(state),
      { kind: "retractJoinCount", joinedAt: state.joinedAt },
    ],
  };
}
