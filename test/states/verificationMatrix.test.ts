/**
 * 入群验证状态机的「状态 × 事件」矩阵：每个状态 kind（expelling 按 reason 拆两行）
 * 对每个事件类型的 next 归类与效果种类。每格现造状态，因为 pending / kickPending /
 * 终态的若干转移原地修改对象。
 */

import { describe, expect, test } from "bun:test";
import {
  checkingInviterOf,
  expellingOf,
  transitionVerification,
} from "../../packages/states/verification";
import type {
  ExpelSnapshot,
  VerificationEffect,
  VerificationEvent,
  VerificationState,
  VerificationTransition,
} from "../../packages/types/states/verification";
import { VERIFICATION_TIMEOUT_MS } from "../../packages/consts/antiRaid/verification";

type VerificationRowLabel =
  | "absent"
  | "pending"
  | "exempt"
  | "kickPending"
  | "kicked"
  | "checkingInviter"
  | "expelling:timeout"
  | "expelling:flood";
/** 转移后的 next：删除记录、原样返回同一对象（含原地修改），或新对象的 kind。 */
type VerificationNextLabel = "absent" | "same" | VerificationState["kind"];
type VerificationCell = readonly [VerificationNextLabel, readonly VerificationEffect["kind"][]];

const JOINED_AT: number = 1_000;
/** 距入群 1 秒：在双路投递误差窗口内，也远未到提醒未送达的续期上限。 */
const NOW: number = 2_000;
const LABEL: string = "杂鱼A";

const SNAPSHOT: ExpelSnapshot = {
  label: LABEL,
  isBot: false,
  announcementMessageId: 10,
  reminderMessageId: 11,
  replyReminderMessageId: undefined,
  joinedAt: JOINED_AT,
  expiresAt: JOINED_AT + VERIFICATION_TIMEOUT_MS,
};

/** 每格现造一份状态；pending 已有可见提醒，kickPending 尚未执行。 */
const VERIFICATION_ROWS: Readonly<Record<VerificationRowLabel, () => VerificationState | undefined>> = {
  absent: (): VerificationState | undefined => undefined,
  pending: (): VerificationState => ({
    kind: "pending",
    label: LABEL,
    isBot: false,
    announcementMessageId: 10,
    trackedMessageTimes: [],
    invitedBy: undefined,
    reminderMessageId: 11,
    replyReminderMessageId: undefined,
    replyReminderRequested: false,
    welcomeAnchorMessageId: undefined,
    reminderSuperseded: false,
    joinedAt: JOINED_AT,
    expiresAt: JOINED_AT + VERIFICATION_TIMEOUT_MS,
  }),
  exempt: (): VerificationState => ({ kind: "exempt", label: LABEL, isBot: false }),
  kickPending: (): VerificationState => ({
    kind: "kickPending",
    label: LABEL,
    isBot: false,
    requestedAt: JOINED_AT,
    countedJoinAt: JOINED_AT,
    announcementMessageId: 10,
    effectStarted: false,
    executionStarted: false,
  }),
  kicked: (): VerificationState => ({ kind: "kicked", label: LABEL, isBot: false, kickedAt: JOINED_AT }),
  checkingInviter: (): VerificationState => checkingInviterOf(7, SNAPSHOT),
  "expelling:timeout": (): VerificationState => expellingOf("timeout", SNAPSHOT),
  "expelling:flood": (): VerificationState => expellingOf("flood", SNAPSHOT),
};

/** 每个事件类型一列；参数取最常见的形态（自主入群、本人点按钮、非管理员拉人者）。 */
const VERIFICATION_COLUMNS: Readonly<Record<VerificationEvent["type"], () => VerificationEvent>> = {
  join: (): VerificationEvent => ({
    type: "join",
    memberId: 100,
    label: LABEL,
    isBot: false,
    identityExempt: false,
    actorSyncExempt: false,
    adminCacheFresh: true,
    lockdownActive: false,
    now: NOW,
  }),
  left: (): VerificationEvent => ({ type: "left" }),
  guardDisabled: (): VerificationEvent => ({ type: "guardDisabled" }),
  trackedMessage: (): VerificationEvent => ({
    type: "trackedMessage",
    messageId: 20,
    inCommentThread: false,
    now: NOW,
  }),
  confirmedThreadComment: (): VerificationEvent => ({
    type: "confirmedThreadComment",
    messageId: 21,
    now: NOW,
    allowFloodTerminalExemption: true,
  }),
  callback: (): VerificationEvent => ({
    type: "callback",
    callbackQueryId: "callback-1",
    action: "self",
    isSelf: true,
    fromCanApprove: false,
    fromLabel: LABEL,
  }),
  adminCheckResolved: (): VerificationEvent => ({ type: "adminCheckResolved" }),
  verifyTimeout: (): VerificationEvent => ({ type: "verifyTimeout", now: NOW }),
  terminalPersisted: (): VerificationEvent => ({ type: "terminalPersisted" }),
  terminalAttemptBudgetExhausted: (): VerificationEvent => ({ type: "terminalAttemptBudgetExhausted" }),
  timeoutInviterVerdict: (): VerificationEvent => ({ type: "timeoutInviterVerdict", inviterIsAdmin: false }),
  expelSettled: (): VerificationEvent => ({ type: "expelSettled" }),
  kickRetry: (): VerificationEvent => ({ type: "kickRetry" }),
  kickSettled: (): VerificationEvent => ({ type: "kickSettled", now: NOW }),
  reminderLanded: (): VerificationEvent => ({
    type: "reminderLanded",
    reminderKind: "reply",
    messageId: 22,
    now: NOW,
  }),
  dedupeExpired: (): VerificationEvent => ({ type: "dedupeExpired" }),
};

const SAME: VerificationCell = ["same", []];
const GONE: VerificationCell = ["absent", []];
/** 本轮入群被新一次物理入群替换：先删旧记录的提醒，再按 ABSENT 重新开验证。 */
const REPLACED_BY_JOIN: VerificationCell = ["pending", ["deleteReminders", "sendReminder"]];

/** 除列出的格子外，其余事件一律按 `fallback` 处理。 */
function verificationRow(
  cells: Partial<Record<VerificationEvent["type"], VerificationCell>>,
  fallback: VerificationCell = SAME
): Record<VerificationEvent["type"], VerificationCell> {
  const row: Partial<Record<VerificationEvent["type"], VerificationCell>> = {};
  for (const column of Object.keys(VERIFICATION_COLUMNS) as VerificationEvent["type"][]) {
    row[column] = cells[column] ?? fallback;
  }
  return row as Record<VerificationEvent["type"], VerificationCell>;
}

const VERIFICATION_MATRIX: Readonly<Record<
  VerificationRowLabel,
  Readonly<Record<VerificationEvent["type"], VerificationCell>>
>> = {
  absent: verificationRow({
    join: ["pending", ["sendReminder"]],
    callback: ["absent", ["answerCallback"]],
    reminderLanded: ["absent", ["deleteMessage"]],
  }, GONE),
  pending: verificationRow({
    left: ["absent", ["deleteReminders"]],
    guardDisabled: ["absent", ["deleteReminders"]],
    trackedMessage: ["same", ["sendReplyReminder", "deleteMessage"]],
    confirmedThreadComment: ["exempt", ["deleteReminders", "retractJoinCount", "sendWelcome"]],
    callback: ["absent", ["answerCallback", "deleteReminders", "sendWelcome"]],
    adminCheckResolved: ["exempt", ["deleteReminders", "retractJoinCount"]],
    verifyTimeout: ["expelling", []],
  }),
  exempt: verificationRow({
    left: GONE,
    guardDisabled: GONE,
    callback: ["same", ["answerCallback"]],
    reminderLanded: ["same", ["deleteMessage"]],
    dedupeExpired: GONE,
  }),
  kickPending: verificationRow({
    left: GONE,
    guardDisabled: GONE,
    callback: ["same", ["answerCallback"]],
    terminalPersisted: ["same", ["deleteMessage", "kickMember"]],
    terminalAttemptBudgetExhausted: GONE,
    kickRetry: ["same", ["kickMember"]],
    kickSettled: ["kicked", []],
    reminderLanded: ["same", ["deleteMessage"]],
  }),
  kicked: verificationRow({
    left: GONE,
    guardDisabled: GONE,
    callback: ["same", ["answerCallback"]],
    reminderLanded: ["same", ["deleteMessage"]],
    dedupeExpired: GONE,
  }),
  checkingInviter: verificationRow({
    join: REPLACED_BY_JOIN,
    guardDisabled: ["absent", ["deleteReminders"]],
    callback: ["same", ["answerCallback"]],
    terminalPersisted: ["same", ["recheckInviter"]],
    terminalAttemptBudgetExhausted: GONE,
    timeoutInviterVerdict: ["expelling", []],
    reminderLanded: ["same", ["deleteMessage"]],
  }),
  "expelling:timeout": verificationRow({
    join: REPLACED_BY_JOIN,
    guardDisabled: ["absent", ["deleteReminders"]],
    callback: ["same", ["answerCallback"]],
    terminalPersisted: ["same", ["expel"]],
    terminalAttemptBudgetExhausted: GONE,
    expelSettled: GONE,
    reminderLanded: ["same", ["deleteMessage"]],
  }),
  "expelling:flood": verificationRow({
    join: REPLACED_BY_JOIN,
    guardDisabled: ["absent", ["deleteReminders"]],
    confirmedThreadComment: ["exempt", ["deleteReminders", "retractJoinCount", "sendWelcome"]],
    callback: ["same", ["answerCallback"]],
    terminalPersisted: ["same", ["expelFlood"]],
    terminalAttemptBudgetExhausted: GONE,
    expelSettled: GONE,
    reminderLanded: ["same", ["deleteMessage"]],
  }),
};

function verificationNextLabel(
  before: VerificationState | undefined,
  next: VerificationState | undefined
): VerificationNextLabel {
  if (next === undefined) return "absent";
  if (next === before) return "same";
  return next.kind;
}

describe("入群验证状态 × 事件矩阵", () => {
  for (const row of Object.keys(VERIFICATION_ROWS) as VerificationRowLabel[]) {
    test(`${row} 行：每个事件的 next 归类与效果种类`, () => {
      const actual: Partial<Record<VerificationEvent["type"], VerificationCell>> = {};
      for (const column of Object.keys(VERIFICATION_COLUMNS) as VerificationEvent["type"][]) {
        const before: VerificationState | undefined = VERIFICATION_ROWS[row]();
        const transition: VerificationTransition =
          transitionVerification(before, VERIFICATION_COLUMNS[column]());
        actual[column] = [
          verificationNextLabel(before, transition.next),
          transition.effects.map(
            (effect: VerificationEffect): VerificationEffect["kind"] => effect.kind
          ),
        ];
      }
      expect(actual).toEqual(VERIFICATION_MATRIX[row]);
    });
  }

  test("执行预算耗尽：只有三个终态被卸载并保留最后一份持久化快照，其余状态原样返回", () => {
    const retained: VerificationRowLabel[] = [];
    for (const row of Object.keys(VERIFICATION_ROWS) as VerificationRowLabel[]) {
      const before: VerificationState | undefined = VERIFICATION_ROWS[row]();
      const transition: VerificationTransition =
        transitionVerification(before, { type: "terminalAttemptBudgetExhausted" });
      if (transition.retainPersistedSnapshot === true) {
        expect(transition.next).toBeUndefined();
        retained.push(row);
      } else {
        expect(transition.next).toBe(before);
      }
      expect(transition.effects).toEqual([]);
    }
    expect(retained).toEqual([
      "kickPending",
      "checkingInviter",
      "expelling:timeout",
      "expelling:flood",
    ]);
  });

  test("处置完成只让 expelling 退出，并且不带 tombstone 豁免标记", () => {
    for (const row of ["expelling:timeout", "expelling:flood"] as const) {
      const transition: VerificationTransition =
        transitionVerification(VERIFICATION_ROWS[row](), { type: "expelSettled" });
      expect(transition).toEqual({ next: undefined, effects: [] });
    }
    const inviterCheck: VerificationState | undefined = VERIFICATION_ROWS.checkingInviter();
    expect(transitionVerification(inviterCheck, { type: "expelSettled" }))
      .toEqual({ next: inviterCheck, effects: [] });
  });
});
