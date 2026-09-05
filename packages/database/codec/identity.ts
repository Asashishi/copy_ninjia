import { IDENTITY_META_KEYS, WHITELIST_DATA_KEYS, BLOCKLIST_DATA_KEYS, TOKYO_TIMESTAMP_PATTERN } from "../../consts/storageSchema";
import {
  BLOCKLIST_REMOVAL_ENTRY_KEYS,
  BLOCKLIST_REMOVAL_FAILURE_TYPES,
  BLOCKLIST_REMOVAL_PARAM_KEYS,
} from "../../consts/antiRaid/blocklist";
import { WHITELIST_PERMISSION_KEYS } from "../../consts/whitelist";
import { invalidInput, parseJsonInput } from "../../libs/inputValidation";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type {
  BlocklistRemovalFailure,
  PendingBlockedRemoval,
  PendingBlockedRemovalParams,
} from "../../types/blocklist";
import type {
  BlocklistEntryData,
  TelegramIdentityMetadata,
  WhitelistEntryData,
  WhitelistPermissions,
} from "../../types/identityPolicy";

/** 严格校验 SQLite 主键可直接表示 Telegram 用户或频道 ID。 */
export function assertTelegramIdentityId(id: number, source: string): void {
  if (!Number.isSafeInteger(id) || id === 0) {
    return invalidInput(source, "$.id", "a non-zero safe integer Telegram identity ID");
  }
}

/** 严格解析身份 metadata；白名单与黑名单 decoder 共用。 */
function parseIdentityMetadata(
  value: unknown,
  source: string,
  path: string
): Readonly<TelegramIdentityMetadata> {
  if (!isPlainRecord(value) || !hasExactKeys(value, IDENTITY_META_KEYS)) {
    return invalidInput(source, path, "an object with firstName, lastName, and username strings");
  }
  if (typeof value.firstName !== "string") {
    return invalidInput(source, `${path}.firstName`, "a string");
  }
  if (typeof value.lastName !== "string") {
    return invalidInput(source, `${path}.lastName`, "a string");
  }
  if (typeof value.username !== "string") {
    return invalidInput(source, `${path}.username`, "a string");
  }
  return {
    firstName: value.firstName,
    lastName: value.lastName,
    username: value.username,
  };
}

function parseStoredPermissions(
  value: unknown,
  source: string
): Readonly<WhitelistPermissions> {
  if (!isPlainRecord(value) || !hasExactKeys(value, WHITELIST_PERMISSION_KEYS)) {
    return invalidInput(source, "$.permissions", "the complete supported boolean permission object");
  }
  const permissions: WhitelistPermissions = {} as WhitelistPermissions;
  for (const key of WHITELIST_PERMISSION_KEYS) {
    const permission: unknown = value[key];
    if (typeof permission !== "boolean") {
      return invalidInput(source, `$.permissions.${key}`, "a boolean");
    }
    permissions[key] = permission;
  }
  return permissions;
}

/** 严格解码 whitelist_entries.data；存在但非法的字段不会被默认值掩盖。 */
export function decodeWhitelistEntryData(
  text: string,
  source: string
): Readonly<WhitelistEntryData> {
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value) || !hasExactKeys(value, WHITELIST_DATA_KEYS)) {
    return invalidInput(source, "$", "an object with permissions and meta");
  }
  return {
    permissions: parseStoredPermissions(value.permissions, source),
    meta: parseIdentityMetadata(value.meta, source, "$.meta"),
  };
}

/** 严格解码 blocklist_entries.data。 */
export function decodeBlocklistEntryData(
  text: string,
  source: string
): Readonly<BlocklistEntryData> {
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value) || !hasExactKeys(value, BLOCKLIST_DATA_KEYS)) {
    return invalidInput(source, "$", "an object with blockedAt and meta");
  }
  if (
    typeof value.blockedAt !== "string" ||
    !TOKYO_TIMESTAMP_PATTERN.test(value.blockedAt)
  ) {
    return invalidInput(source, "$.blockedAt", "a YYYY/MM/DD HH:mm:ss string");
  }
  return {
    blockedAt: value.blockedAt,
    meta: parseIdentityMetadata(value.meta, source, "$.meta"),
  };
}

function isFailureType(value: unknown): value is BlocklistRemovalFailure {
  return typeof value === "string" &&
    BLOCKLIST_REMOVAL_FAILURE_TYPES.includes(value as BlocklistRemovalFailure);
}

function decodePendingParams(
  value: unknown,
  source: string
): PendingBlockedRemovalParams {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, BLOCKLIST_REMOVAL_PARAM_KEYS)) {
    return invalidInput(source, "$.params", "the current pending removal parameter shape");
  }
  if (!isTelegramGroupChatId(value.chatId)) {
    return invalidInput(
      source,
      "$.params.chatId",
      "a negative safe integer Telegram group or channel ID"
    );
  }
  if (!Number.isSafeInteger(value.removalId) || (value.removalId as number) < 1) {
    return invalidInput(source, "$.params.removalId", "a positive safe integer");
  }
  if (typeof value.probeMembership !== "boolean") {
    return invalidInput(source, "$.params.probeMembership", "a boolean");
  }
  const chatId: number = value.chatId;
  const removalId: number = value.removalId as number;
  if (value.probeMembership) {
    if (
      value.userIds !== undefined ||
      value.joinedAt !== undefined ||
      value.announcementMessageId !== undefined
    ) {
      return invalidInput(source, "$.params", "a sweep without frozen member fields");
    }
    return { chatId, probeMembership: true, removalId };
  }
  if (
    !Array.isArray(value.userIds) ||
    value.userIds.length === 0 ||
    value.userIds.some(
      (id: unknown): boolean => !Number.isSafeInteger(id) || id === 0
    )
  ) {
    return invalidInput(source, "$.params.userIds", "a non-empty array of unique non-zero safe integers");
  }
  const userIds: number[] = value.userIds as number[];
  if (new Set<number>(userIds).size !== userIds.length) {
    return invalidInput(source, "$.params.userIds", "unique identity IDs");
  }
  if (
    value.joinedAt !== undefined &&
    (!Number.isSafeInteger(value.joinedAt) || (value.joinedAt as number) < 0)
  ) {
    return invalidInput(source, "$.params.joinedAt", "a non-negative safe integer");
  }
  if (
    value.announcementMessageId !== undefined &&
    (!Number.isSafeInteger(value.announcementMessageId) ||
      (value.announcementMessageId as number) < 1)
  ) {
    return invalidInput(source, "$.params.announcementMessageId", "a positive safe integer");
  }
  return {
    chatId,
    probeMembership: false,
    userIds: [...userIds],
    removalId,
    joinedAt: value.joinedAt as number | undefined,
    announcementMessageId: value.announcementMessageId as number | undefined,
  };
}

/** 严格解码 pending_blocked_removals.data。 */
export function decodePendingBlockedRemovalData(
  text: string,
  source: string
): PendingBlockedRemoval {
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value) || !hasExactKeys(value, BLOCKLIST_REMOVAL_ENTRY_KEYS)) {
    return invalidInput(source, "$", "the current pending removal entry shape");
  }
  if (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) {
    return invalidInput(source, "$.createdAt", "a non-negative safe integer");
  }
  if (!Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0) {
    return invalidInput(source, "$.attempts", "a non-negative safe integer");
  }
  if (value.lastFailure !== null && !isFailureType(value.lastFailure)) {
    return invalidInput(source, "$.lastFailure", "null or a supported failure type");
  }
  return {
    params: decodePendingParams(value.params, source),
    createdAt: value.createdAt as number,
    attempts: value.attempts as number,
    lastFailure: value.lastFailure,
  };
}

/** 编码前先走同一严格解码器，避免内存中的非法结构进入数据库。 */
export function encodeWhitelistEntryData(
  value: Readonly<WhitelistEntryData>,
  source: string = "whitelist entry"
): string {
  const text: string = JSON.stringify(value);
  decodeWhitelistEntryData(text, source);
  return text;
}

/** 编码前先走同一严格解码器。 */
export function encodeBlocklistEntryData(
  value: Readonly<BlocklistEntryData>,
  source: string = "blocklist entry"
): string {
  const text: string = JSON.stringify(value);
  decodeBlocklistEntryData(text, source);
  return text;
}

/** 编码结果连同校验时已经解出来的规范值一起交出，避免调用方重复 parse。 */
export interface EncodedPendingBlockedRemoval {
  /** 落库文本；同一个值反复编码逐字节稳定，可直接用于变更比较。 */
  readonly text: string;
  /** 校验过程本来就解出来的规范值；丢掉它只会让调用方紧接着再 parse 一遍。 */
  readonly value: PendingBlockedRemoval;
}

/**
 * 编码前先走同一严格解码器，并把那次解码的结果一并返回。
 *
 * outbox 快照对每一条 removal 都要「编码 -> 落库文本」和「规范值 -> 内存镜像」
 * 两样东西（见 workers/diskIO/storageDatabase/pendingRemoval.ts 的
 * handlePendingRemovalSnapshot）。
 * 只回 text 的话调用方必须紧接着再解一次同一段 JSON，等于每条持久化条目多付一次
 * 完整 parse + 全量校验。
 */
export function encodePendingBlockedRemovalData(
  value: PendingBlockedRemoval,
  source: string = "pending blocked removal"
): EncodedPendingBlockedRemoval {
  const text: string = JSON.stringify(value);
  return { text, value: decodePendingBlockedRemovalData(text, source) };
}
