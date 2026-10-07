/** Anti-Raid 待验证日文件的无状态 codec；不读取 Disk I/O Worker 缓存。 */

import { ANTI_RAID_PER_MINUTE_LIMIT } from "../../consts/antiRaid/lockdown";
import {
  VERIFICATION_BASE_RECORD_KEYS,
  VERIFICATION_CHECKING_INVITER_RECORD_KEYS,
  VERIFICATION_EXPELLING_RECORD_KEYS,
  VERIFICATION_FILE_VERSION,
  VERIFICATION_KICK_PENDING_RECORD_KEYS,
  VERIFICATION_LABEL_MAX_CHARS,
} from "../../consts/diskIO/verification";
import { parseVerificationKey, verificationKey } from "../../libs/verificationKey";
import type { ParsedVerificationKey } from "../../libs/verificationKey";
import { invalidInput, parseJsonInput } from "../../libs/inputValidation";
import { isPlainRecord } from "../../libs/record";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type {
  VerificationSnapshot,
  VerificationSnapshotBase,
} from "../../types/antiRaid/verification";

export type VerificationDayValue = VerificationSnapshot | null;

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

/** 按 phase 拒绝未知字段。 */
function hasCurrentVerificationKeys(value: Record<string, unknown>): boolean {
  let allowed: ReadonlySet<string> = VERIFICATION_BASE_RECORD_KEYS;
  if (value.phase === "kickPending") {
    allowed = VERIFICATION_KICK_PENDING_RECORD_KEYS;
  } else if (value.phase === "checkingInviter") {
    allowed = VERIFICATION_CHECKING_INVITER_RECORD_KEYS;
  } else if (value.phase === "expelling") {
    allowed = VERIFICATION_EXPELLING_RECORD_KEYS;
  }
  for (const key in value) {
    if (Object.hasOwn(value, key) && !allowed.has(key)) return false;
  }
  return true;
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

/**
 * 校验各 phase 共有的字段与记录键，返回公共部分；任一项不合法返回 null。本 phase 不允许的
 * 字段已由 hasCurrentVerificationKeys 的白名单拒绝（JSON 解析结果不含 undefined 值，键在即值在）。
 */
function decodeVerificationBase(
  key: string,
  value: Record<string, unknown>
): VerificationSnapshotBase | null {
  if (
    value.version !== VERIFICATION_FILE_VERSION ||
    !isTelegramGroupChatId(value.chatId) ||
    !isPositiveId(value.userId) ||
    !isPositiveId(value.generation) ||
    !isPositiveId(value.revision) ||
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
    key !== verificationKey(value.chatId, value.userId)
  ) return null;
  return {
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
}

/** kickPending：本次入群的动作时刻同时是入群与到期时刻。 */
function decodeKickPending(
  base: VerificationSnapshotBase,
  value: Record<string, unknown>
): VerificationSnapshot | null {
  const requestedAt: unknown = value.requestedAt;
  const countedJoinAt: unknown = value.countedJoinAt;
  if (
    !isSafeTimestamp(requestedAt) ||
    !isOptionalSafeTimestamp(countedJoinAt) ||
    base.joinedAt !== requestedAt ||
    base.expiresAt !== requestedAt
  ) return null;
  return { ...base, phase: "kickPending", requestedAt, countedJoinAt };
}

/** checkingInviter：带最终核查对象。 */
function decodeCheckingInviter(
  base: VerificationSnapshotBase,
  value: Record<string, unknown>
): VerificationSnapshot | null {
  const terminalInviterId: unknown = value.terminalInviterId;
  if (!isPositiveId(terminalInviterId)) return null;
  return { ...base, phase: "checkingInviter", terminalInviterId };
}

/** expelling：处置原因与可选的播报/确认标志。 */
function decodeExpelling(
  base: VerificationSnapshotBase,
  value: Record<string, unknown>
): VerificationSnapshot | null {
  const expelReason: unknown = value.expelReason;
  const successNoticeSent: unknown = value.successNoticeSent;
  const failureNoticeSent: unknown = value.failureNoticeSent;
  const unconfirmedNoticeSent: unknown = value.unconfirmedNoticeSent;
  const removalConfirmed: unknown = value.removalConfirmed;
  if (
    (expelReason !== "timeout" && expelReason !== "flood") ||
    !isOptionalBoolean(successNoticeSent) ||
    !isOptionalBoolean(failureNoticeSent) ||
    !isOptionalBoolean(unconfirmedNoticeSent) ||
    !isOptionalBoolean(removalConfirmed)
  ) return null;
  return {
    ...base,
    phase: "expelling",
    expelReason,
    successNoticeSent,
    failureNoticeSent,
    unconfirmedNoticeSent,
    removalConfirmed,
  };
}

/**
 * 对当天文件中的最新值逐字段校验，不把畸形数据带回业务 Worker。
 *
 * 只服务同文件的 decodeVerificationDay，不导出：单条记录的合法性判据依附于
 * 「整份日文件要么全收、要么整份拒绝」。
 */
function decodeVerificationSnapshot(
  key: string,
  value: unknown
): VerificationSnapshot | null {
  if (!isPlainRecord(value) || !hasCurrentVerificationKeys(value)) return null;
  const base: VerificationSnapshotBase | null = decodeVerificationBase(key, value);
  if (base === null) return null;
  switch (value.phase) {
    case "pending":
      return { ...base, phase: "pending" };
    case "kickPending":
      return decodeKickPending(base, value);
    case "checkingInviter":
      return decodeCheckingInviter(base, value);
    case "expelling":
      return decodeExpelling(base, value);
    default:
      return null;
  }
}

/** 把内存快照转成带格式版本的日文件值。 */
export function storedVerificationSnapshot(
  snapshot: VerificationSnapshot
): Record<string, unknown> {
  return { version: VERIFICATION_FILE_VERSION, ...snapshot };
}

/** null 墓碑的键同样必须是「群 id:正整数用户 id」的规范验证键。 */
function isVerificationTombstoneKey(key: string): boolean {
  const parsed: ParsedVerificationKey | null = parseVerificationKey(key);
  return parsed !== null && isTelegramGroupChatId(parsed.chatId) && isPositiveId(parsed.userId);
}

/** 严格解码完整日文件；任一 active 记录或墓碑键畸形时整份拒绝。 */
export function decodeVerificationDay(
  path: string,
  content: string
): Map<string, VerificationDayValue> {
  const parsed: unknown = parseJsonInput(content, path);
  if (!isPlainRecord(parsed)) return invalidInput(path, "$", "a JSON object of verification records");

  const decoded: Map<string, VerificationDayValue> = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null) {
      if (!isVerificationTombstoneKey(key)) {
        return invalidInput(path, "$.<record>", "a current verification record or null tombstone");
      }
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
