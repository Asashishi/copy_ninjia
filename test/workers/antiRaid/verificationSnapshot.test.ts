import { afterEach, beforeEach, expect, test } from "bun:test";
import { verificationGeneration } from "../../../packages/cache/workers/antiRaid/verification";
import { verificationSnapshot } from "../../../packages/workers/antiRaid/verificationSnapshot";
import { decodeVerificationDay, storedVerificationSnapshot } from "../../../packages/workers/diskIO/verificationCodec";
import type { ExpelSnapshot, PendingState, VerificationState } from "../../../packages/types/states/verification";
import type { VerificationSnapshot } from "../../../packages/types/antiRaid/verification";

const source: ExpelSnapshot = {
  label: "待验证成员", isBot: false,
  joinedAt: 1_783_000_000_000, expiresAt: 1_783_000_180_000,
  announcementMessageId: 11, reminderMessageId: 12, replyReminderMessageId: 13,
};

beforeEach((): void => { verificationGeneration.current = 1; });
afterEach((): void => { verificationGeneration.current = 0; });

test("pending 快照独立持有时间戳并可经当前落盘格式恢复", (): void => {
  const state: PendingState = {
    ...source, kind: "pending", trackedMessageTimes: [source.joinedAt],
    invitedBy: 23, replyReminderRequested: true, welcomeAnchorMessageId: 14, reminderSuperseded: true,
  };
  const before: PendingState = structuredClone(state);
  const snapshot: VerificationSnapshot = verificationSnapshot({ chatId: -1001, userId: 42, state, revision: 7 });
  expect(state).toEqual(before);
  expect(snapshot).toMatchObject({
    phase: "pending", chatId: -1001, userId: 42, revision: 7,
    trackedMessageTimes: before.trackedMessageTimes, invitedBy: 23,
    welcomeAnchorMessageId: 14, replyReminderRequested: true, reminderSuperseded: true,
  });
  expect(snapshot.trackedMessageTimes).not.toBe(state.trackedMessageTimes);
  state.trackedMessageTimes.push(source.joinedAt + 1);
  expect(snapshot.trackedMessageTimes).toEqual(before.trackedMessageTimes);
  expect(decodeVerificationDay("fixture", JSON.stringify({ "-1001:42": storedVerificationSnapshot(snapshot) })).get("-1001:42")).toEqual(snapshot);
});

test("终态快照保留各阶段字段且不会回写状态对象", (): void => {
  const states: readonly Exclude<VerificationState, { kind: "pending" | "exempt" | "kicked" }>[] = [
    { kind: "kickPending", label: "bot", isBot: true, requestedAt: source.joinedAt, countedJoinAt: source.joinedAt, effectStarted: true, executionStarted: false },
    { kind: "checkingInviter", inviterId: 23, snapshot: source },
    { kind: "expelling", reason: "timeout", snapshot: source, successNoticeSent: true, failureNoticeSent: false, unconfirmedNoticeSent: false, removalConfirmed: true },
    { kind: "expelling", reason: "flood", snapshot: source, successNoticeSent: false, failureNoticeSent: true, unconfirmedNoticeSent: true },
  ];
  for (const state of states) {
    const before: typeof state = structuredClone(state);
    const snapshot: VerificationSnapshot = verificationSnapshot({ chatId: -1001, userId: 42, state, revision: 8 });
    expect(state).toEqual(before);
    expect(snapshot.phase).toBe(state.kind);
    expect(snapshot.trackedMessageTimes).toEqual([]);
    if (state.kind === "kickPending") expect(snapshot).toMatchObject({ requestedAt: state.requestedAt, countedJoinAt: state.countedJoinAt });
    else if (state.kind === "checkingInviter") expect(snapshot).toMatchObject({ terminalInviterId: state.inviterId });
    else expect(snapshot).toMatchObject({ expelReason: state.reason, successNoticeSent: state.successNoticeSent, failureNoticeSent: state.failureNoticeSent, unconfirmedNoticeSent: state.unconfirmedNoticeSent, removalConfirmed: state.removalConfirmed });
    expect(decodeVerificationDay("fixture", JSON.stringify({ "-1001:42": storedVerificationSnapshot(snapshot) })).get("-1001:42")).toEqual(snapshot);
  }
});
