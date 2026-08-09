/** Anti-Raid 待验证日文件的无状态 codec；不读取 Disk I/O Worker 缓存。 */

import { ANTI_RAID_PER_MINUTE_LIMIT } from "../../consts/antiRaid/lockdown";
import {
  VERIFICATION_FILE_VERSION,
  VERIFICATION_LABEL_MAX_CHARS,
} from "../../consts/diskIO/verification";
import { verificationKey } from "../../libs/verificationKey";
import { invalidInput, parseJsonInput } from "../../libs/inputValidation";
import { hasOnlyKeys } from "../../libs/runtimeConfig";
import type {
  VerificationSnapshot,
  VerificationSnapshotBase,
} from "../../types/antiRaid";

export type VerificationDayValue = VerificationSnapshot | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOptionalPositiveId(value: unknown): value is number | undefined {
  return value === undefined || isPositiveId(value);
}

function isOptionalSafeTimestamp(value: unknown): value is number | undefined {
  return value === undefined || isSafeTimestamp(value);
}

/** 按 phase 拒绝未知字段，避免 compact 时静默甩掉状态内容。 */
function hasCurrentVerificationKeys(value: Record<string, unknown>): boolean {
  const baseKeys: readonly string[] = [
    "version", "chatId", "userId", "generation", "revision", "phase", "label",
    "isBot", "announcementMessageId", "trackedMessageTimes", "invitedBy",
    "reminderMessageId", "replyReminderMessageId", "replyReminderRequested",
    "welcomeAnchorMessageId", "reminderSuperseded", "joinedAt", "expiresAt",
  ];
  if (value.phase === "kickPending") {
    return hasOnlyKeys(value, [...baseKeys, "requestedAt", "countedJoinAt"]);
  }
  if (value.phase === "checkingInviter") {
    return hasOnlyKeys(value, [...baseKeys, "terminalInviterId"]);
  }
  if (value.phase === "expelling") {
    return hasOnlyKeys(value, [
      ...baseKeys,
      "expelReason",
      "successNoticeSent",
      "failureNoticeSent",
      "unconfirmedNoticeSent",
      "removalConfirmed",
    ]);
  }
  return hasOnlyKeys(value, baseKeys);
}

/** 对当天文件中的最新值逐字段校验，不把畸形数据带回业务 Worker。 */
export function decodeVerificationSnapshot(
  key: string,
  value: unknown
): VerificationSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !hasCurrentVerificationKeys(value) ||
    value.version !== VERIFICATION_FILE_VERSION ||
    typeof value.chatId !== "number" ||
    !Number.isSafeInteger(value.chatId) ||
    value.chatId === 0 ||
    !isPositiveId(value.userId) ||
    !isPositiveId(value.generation) ||
    !isPositiveId(value.revision) ||
    (value.phase !== "pending" &&
      value.phase !== "kickPending" &&
      value.phase !== "checkingInviter" &&
      value.phase !== "expelling") ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    value.label.length > VERIFICATION_LABEL_MAX_CHARS ||
    typeof value.isBot !== "boolean" ||
    !Array.isArray(value.trackedMessageTimes) ||
    value.trackedMessageTimes.length > ANTI_RAID_PER_MINUTE_LIMIT ||
    !value.trackedMessageTimes.every(isSafeTimestamp) ||
    !isOptionalPositiveId(value.announcementMessageId) ||
    !isOptionalPositiveId(value.invitedBy) ||
    !isOptionalPositiveId(value.reminderMessageId) ||
    !isOptionalPositiveId(value.replyReminderMessageId) ||
    typeof value.replyReminderRequested !== "boolean" ||
    !isOptionalPositiveId(value.welcomeAnchorMessageId) ||
    typeof value.reminderSuperseded !== "boolean" ||
    !isSafeTimestamp(value.joinedAt) ||
    !isSafeTimestamp(value.expiresAt) ||
    value.expiresAt < value.joinedAt ||
    (value.phase === "kickPending" && (
      !isSafeTimestamp(value.requestedAt) ||
      !isOptionalSafeTimestamp(value.countedJoinAt) ||
      value.joinedAt !== value.requestedAt ||
      value.expiresAt !== value.requestedAt ||
      value.terminalInviterId !== undefined ||
      value.expelReason !== undefined ||
      value.successNoticeSent !== undefined ||
      value.failureNoticeSent !== undefined ||
      value.unconfirmedNoticeSent !== undefined ||
      value.removalConfirmed !== undefined
    )) ||
    (value.phase === "checkingInviter" && (
      value.requestedAt !== undefined ||
      value.countedJoinAt !== undefined ||
      !isPositiveId(value.terminalInviterId) ||
      value.expelReason !== undefined ||
      value.successNoticeSent !== undefined ||
      value.failureNoticeSent !== undefined ||
      value.unconfirmedNoticeSent !== undefined ||
      value.removalConfirmed !== undefined
    )) ||
    (value.phase === "expelling" && (
      value.requestedAt !== undefined ||
      value.countedJoinAt !== undefined ||
      (value.expelReason !== "timeout" && value.expelReason !== "flood") ||
      value.terminalInviterId !== undefined ||
      (value.successNoticeSent !== undefined && typeof value.successNoticeSent !== "boolean") ||
      (value.failureNoticeSent !== undefined && typeof value.failureNoticeSent !== "boolean") ||
      (value.unconfirmedNoticeSent !== undefined && typeof value.unconfirmedNoticeSent !== "boolean") ||
      (value.removalConfirmed !== undefined && typeof value.removalConfirmed !== "boolean")
    )) ||
    (value.phase === "pending" && (
      value.requestedAt !== undefined ||
      value.countedJoinAt !== undefined ||
      value.terminalInviterId !== undefined ||
      value.expelReason !== undefined ||
      value.successNoticeSent !== undefined ||
      value.failureNoticeSent !== undefined ||
      value.unconfirmedNoticeSent !== undefined ||
      value.removalConfirmed !== undefined
    )) ||
    key !== verificationKey(value.chatId, value.userId)
  ) return null;

  const base: VerificationSnapshotBase = {
    chatId: value.chatId,
    userId: value.userId,
    generation: value.generation,
    revision: value.revision,
    label: value.label,
    isBot: value.isBot,
    announcementMessageId: value.announcementMessageId,
    trackedMessageTimes: [...value.trackedMessageTimes],
    invitedBy: value.invitedBy,
    reminderMessageId: value.reminderMessageId,
    replyReminderMessageId: value.replyReminderMessageId,
    replyReminderRequested: value.replyReminderRequested,
    welcomeAnchorMessageId: value.welcomeAnchorMessageId,
    reminderSuperseded: value.reminderSuperseded,
    joinedAt: value.joinedAt,
    expiresAt: value.expiresAt,
  };
  if (value.phase === "kickPending") {
    return {
      ...base,
      phase: "kickPending",
      requestedAt: value.requestedAt as number,
      countedJoinAt: value.countedJoinAt as number | undefined,
    };
  }
  if (value.phase === "checkingInviter") {
    return {
      ...base,
      phase: "checkingInviter",
      terminalInviterId: value.terminalInviterId as number,
    };
  }
  if (value.phase === "expelling") {
    return {
      ...base,
      phase: "expelling",
      expelReason: value.expelReason as "timeout" | "flood",
      successNoticeSent: value.successNoticeSent as boolean | undefined,
      failureNoticeSent: value.failureNoticeSent as boolean | undefined,
      unconfirmedNoticeSent: value.unconfirmedNoticeSent as boolean | undefined,
      removalConfirmed: value.removalConfirmed as boolean | undefined,
    };
  }
  return { ...base, phase: "pending" };
}

/** 把内存快照转成带格式版本的日文件值。 */
export function storedVerificationSnapshot(
  snapshot: VerificationSnapshot
): Record<string, unknown> {
  return { version: VERIFICATION_FILE_VERSION, ...snapshot };
}

/** 严格解码完整日文件；任一 active 记录畸形时整份拒绝。 */
export function decodeVerificationDay(
  path: string,
  content: string
): Map<string, VerificationDayValue> {
  const parsed: unknown = parseJsonInput(content, path);
  if (!isRecord(parsed)) return invalidInput(path, "$", "a JSON object of verification records");

  const decoded: Map<string, VerificationDayValue> = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null) {
      decoded.set(key, null);
      continue;
    }
    const snapshot: VerificationSnapshot | null =
      decodeVerificationSnapshot(key, value);
    if (snapshot === null) {
      return invalidInput(path, "$.<record>", "a current verification record or null tombstone");
    }
    decoded.set(key, snapshot);
  }
  return decoded;
}
