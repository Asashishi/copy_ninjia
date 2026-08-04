/** Anti-Raid 待验证日文件的无状态 codec；不读取 Disk I/O Worker 缓存。 */

import { ANTI_RAID_PER_MINUTE_LIMIT } from "../../consts/antiRaid/lockdown";
import {
  VERIFICATION_FILE_VERSION,
  VERIFICATION_LABEL_MAX_CHARS,
} from "../../consts/diskIO/verification";
import { verificationKey } from "../../libs/verificationKey";
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

/** 对当天文件中的最新值逐字段校验，不把畸形数据带回业务 Worker。 */
export function decodeVerificationSnapshot(
  key: string,
  value: unknown
): VerificationSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== VERIFICATION_FILE_VERSION ||
    typeof value.chatId !== "number" ||
    !Number.isSafeInteger(value.chatId) ||
    value.chatId === 0 ||
    !isPositiveId(value.userId) ||
    !isPositiveId(value.generation) ||
    !isPositiveId(value.revision) ||
    (value.phase !== "pending" &&
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
    (value.phase === "checkingInviter" && (
      !isPositiveId(value.terminalInviterId) ||
      value.expelReason !== undefined ||
      value.successNoticeSent !== undefined ||
      value.failureNoticeSent !== undefined ||
      value.unconfirmedNoticeSent !== undefined ||
      value.removalConfirmed !== undefined
    )) ||
    (value.phase === "expelling" && (
      (value.expelReason !== "timeout" && value.expelReason !== "flood") ||
      value.terminalInviterId !== undefined ||
      (value.successNoticeSent !== undefined && typeof value.successNoticeSent !== "boolean") ||
      (value.failureNoticeSent !== undefined && typeof value.failureNoticeSent !== "boolean") ||
      (value.unconfirmedNoticeSent !== undefined && typeof value.unconfirmedNoticeSent !== "boolean") ||
      (value.removalConfirmed !== undefined && typeof value.removalConfirmed !== "boolean")
    )) ||
    (value.phase === "pending" && (
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
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object.`);

  const decoded: Map<string, VerificationDayValue> = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null) {
      decoded.set(key, null);
      continue;
    }
    const snapshot: VerificationSnapshot | null =
      decodeVerificationSnapshot(key, value);
    if (snapshot === null) {
      throw new Error(
        `${path} contains an invalid active pending verification record for key ${key}.`
      );
    }
    decoded.set(key, snapshot);
  }
  return decoded;
}
