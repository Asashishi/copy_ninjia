import { CHAT_STATE_KEYS, LOCKDOWN_KEYS } from "../../consts/storageSchema";
import type { ChatPermissions } from "grammy/types";
import { BOT_CHAT_PERMISSION_KEYS } from "../../consts/botAdmin";
import { CHAT_PERMISSION_KEYS } from "../../consts/storage";
import { invalidInput, parseJsonInput } from "../../libs/inputValidation";
import { isEmptyChatState } from "../../libs/chatState";
import { hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type { ChatState, LockdownPhase, LockdownRecord } from "../../types/chatState";
import type { BotChatPermissions } from "../../types/telegram";

interface DecodeFieldContext {
  readonly source: string;
  readonly path: string;
}

/** 严格校验 SQLite 主键可直接表示 Telegram 群或频道 ID。 */
export function assertTelegramChatId(chatId: number, source: string): void {
  if (!isTelegramGroupChatId(chatId)) {
    return invalidInput(source, "$.chatId", "a negative safe integer Telegram group or channel ID");
  }
}

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  { source, path }: DecodeFieldContext
): boolean | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "boolean") return invalidInput(source, `${path}.${key}`, "a boolean");
  return field;
}

function requiredBoolean(
  value: Record<string, unknown>,
  key: string,
  { source, path }: DecodeFieldContext
): boolean {
  const field: unknown = value[key];
  if (typeof field !== "boolean") return invalidInput(source, `${path}.${key}`, "a required boolean");
  return field;
}

/** Telegram 消息 ID 恒为正整数；0 与负数不是「没有消息」，而是坏数据。 */
function optionalMessageId(
  value: Record<string, unknown>,
  key: string,
  { source, path }: DecodeFieldContext
): number | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (!Number.isSafeInteger(field) || (field as number) < 1) {
    return invalidInput(source, `${path}.${key}`, "a positive safe integer message ID");
  }
  return field as number;
}

function optionalTimestamp(
  value: Record<string, unknown>,
  key: string,
  { source, path }: DecodeFieldContext
): number | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    return invalidInput(source, `${path}.${key}`, "a non-negative safe integer timestamp");
  }
  return field as number;
}

function decodeChatPermissions(
  value: unknown,
  source: string,
  path: string
): ChatPermissions {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CHAT_PERMISSION_KEYS)) {
    return invalidInput(source, path, "an object containing only supported chat permission booleans");
  }
  const permissions: ChatPermissions = {};
  for (const key of CHAT_PERMISSION_KEYS) {
    const field: unknown = value[key];
    if (field === undefined) continue;
    if (typeof field !== "boolean") {
      return invalidInput(source, `${path}.${key}`, "a boolean");
    }
    Reflect.set(permissions, key, field);
  }
  return permissions;
}

function decodeBotPermissions(
  value: unknown,
  source: string,
  path: string
): BotChatPermissions {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, BOT_CHAT_PERMISSION_KEYS)) {
    return invalidInput(source, path, "the complete supported bot permission object");
  }
  const context: DecodeFieldContext = { source, path };
  const permissions: BotChatPermissions = {
    isAdministrator: requiredBoolean(value, "isAdministrator", context),
    isAnonymous: requiredBoolean(value, "isAnonymous", context),
    canManageChat: requiredBoolean(value, "canManageChat", context),
    canDeleteMessages: requiredBoolean(value, "canDeleteMessages", context),
    canManageVideoChats: requiredBoolean(value, "canManageVideoChats", context),
    canRestrictMembers: requiredBoolean(value, "canRestrictMembers", context),
    canPromoteMembers: requiredBoolean(value, "canPromoteMembers", context),
    canChangeInfo: requiredBoolean(value, "canChangeInfo", context),
    canInviteUsers: requiredBoolean(value, "canInviteUsers", context),
    canManageTags: requiredBoolean(value, "canManageTags", context),
    canPostStories: requiredBoolean(value, "canPostStories", context),
    canEditStories: requiredBoolean(value, "canEditStories", context),
    canDeleteStories: requiredBoolean(value, "canDeleteStories", context),
    canPostMessages: requiredBoolean(value, "canPostMessages", context),
    canEditMessages: requiredBoolean(value, "canEditMessages", context),
    canPinMessages: requiredBoolean(value, "canPinMessages", context),
    canManageTopics: requiredBoolean(value, "canManageTopics", context),
    canManageDirectMessages: requiredBoolean(value, "canManageDirectMessages", context),
  };
  if (!permissions.isAdministrator) {
    for (const key of BOT_CHAT_PERMISSION_KEYS) {
      if (key !== "isAdministrator" && permissions[key]) {
        return invalidInput(
          source,
          `${path}.${key}`,
          `false when ${path}.isAdministrator is false`
        );
      }
    }
  }
  return permissions;
}

function decodeLockdown(
  value: unknown,
  source: string,
  path: string
): LockdownRecord {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, LOCKDOWN_KEYS)) {
    return invalidInput(source, path, "the current lockdown object shape");
  }
  const phaseValue: unknown = value.phase;
  if (
    phaseValue !== "applying" &&
    phaseValue !== "active" &&
    phaseValue !== "reconciling" &&
    phaseValue !== "restoring"
  ) {
    return invalidInput(source, `${path}.phase`, "applying, active, reconciling, or restoring");
  }
  const phase: LockdownPhase = phaseValue;
  const context: DecodeFieldContext = { source, path };
  const intentId: number | undefined = optionalTimestamp(value, "intentId", context);
  if (intentId === undefined || intentId === 0) {
    return invalidInput(source, `${path}.intentId`, "a positive safe integer");
  }
  const expiresAt: number | undefined = optionalTimestamp(value, "expiresAt", context);
  if (expiresAt === undefined) {
    return invalidInput(source, `${path}.expiresAt`, "a required non-negative safe integer timestamp");
  }
  const announced: boolean = requiredBoolean(value, "announced", context);
  const announcementMessageId: number | undefined =
    optionalMessageId(value, "announcementMessageId", context);
  if (announcementMessageId !== undefined && !announced) {
    // 消息 ID 只可能来自一次成功的发送，两者必须同时成立。
    return invalidInput(source, `${path}.announcementMessageId`, "absent while announced is false");
  }
  return {
    phase,
    intentId,
    originalPermissions: decodeChatPermissions(
      value.originalPermissions,
      source,
      `${path}.originalPermissions`
    ),
    announced,
    announcementMessageId,
    expiresAt,
  };
}

/**
 * 主线程接收 Worker lockdown 事件时的入站校验。
 *
 * ChatState 是「先写内存、再落盘」的：一条落盘自检过不了的记录挂进内存，会让
 * 该群此后**所有**状态写入（任何开关命令）一并抛错。落盘格式的守门必须提前
 * 到入口，不能等到 encodeChatStateData 才发现。校验规则与磁盘解码同源。
 */
export function assertPersistableLockdown(
  record: LockdownRecord,
  source: string
): void {
  decodeLockdown(record, source, "$.lockdown");
}

/** 严格解码一条 `chat_states.data`；未知字段和空状态都拒绝。 */
export function decodeChatStateData(text: string, source: string): ChatState {
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CHAT_STATE_KEYS)) {
    return invalidInput(source, "$", "an object containing only supported chat-state fields");
  }
  const titleValue: unknown = value.title;
  if (titleValue !== undefined && typeof titleValue !== "string") {
    return invalidInput(source, "$.title", "a string");
  }
  const rootContext: DecodeFieldContext = { source, path: "$" };
  const state: ChatState = {
    quietUntil: optionalTimestamp(value, "quietUntil", rootContext),
    lockdown: value.lockdown === undefined
      ? undefined
      : decodeLockdown(value.lockdown, source, "$.lockdown"),
    isAIChatEnabled: optionalBoolean(value, "isAIChatEnabled", rootContext),
    isJATranslationEnabled: optionalBoolean(value, "isJATranslationEnabled", rootContext),
    isAdDetectEnabled: optionalBoolean(value, "isAdDetectEnabled", rootContext),
    isFloodControlEnabled: optionalBoolean(value, "isFloodControlEnabled", rootContext),
    isAntiRaidEnabled: optionalBoolean(value, "isAntiRaidEnabled", rootContext),
    isInitEnabled: optionalBoolean(value, "isInitEnabled", rootContext),
    botPermissions: value.botPermissions === undefined
      ? undefined
      : decodeBotPermissions(value.botPermissions, source, "$.botPermissions"),
    title: titleValue,
    isProxySendEnabled: optionalBoolean(value, "isProxySendEnabled", rootContext),
  };
  if (isEmptyChatState(state)) {
    return invalidInput(source, "$", "a non-empty chat-state object");
  }
  return state;
}

/** 编码前走同一严格解码器，非法内存状态不得进入 SQLite。 */
export function encodeChatStateData(
  state: Readonly<ChatState>,
  source: string = "chat state"
): string {
  const text: string = JSON.stringify(state);
  decodeChatStateData(text, source);
  return text;
}
