import {
  CACHED_USER_KEYS,
  CHAT_STATE_KEYS,
  LOCKDOWN_KEYS,
  TRANSLATE_SESSION_KEYS,
} from "../../consts/storageSchema";
import type { ChatPermissions } from "grammy/types";
import { BOT_CHAT_PERMISSION_KEYS } from "../../consts/botAdmin";
import { CHAT_PERMISSION_KEYS } from "../../consts/storage";
import {
  invalidInput,
  optionalBooleanField,
  optionalStringField,
  optionalTimestampField,
  parseJsonInput,
} from "../../libs/inputValidation";
import { TRANSLATE_CHAT_USER_LIMIT } from "../../consts/translate";
import type { InputFieldContext } from "../../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../../libs/record";
import { isTelegramGroupChatId } from "../../libs/telegramId";
import type { CachedUser, ChatState, LockdownPhase, LockdownRecord } from "../../types/chatState";
import type { TranslateState } from "../../types/translate";
import type { BotChatPermissions } from "../../types/telegram";

/** 严格校验 SQLite 主键可直接表示 Telegram 群或频道 ID。 */
export function assertTelegramChatId(chatId: number, source: string): void {
  if (!isTelegramGroupChatId(chatId)) {
    return invalidInput(source, "$.chatId", "a negative safe integer Telegram group or channel ID");
  }
}

function requiredBoolean(
  value: Record<string, unknown>,
  key: string,
  { source, path }: InputFieldContext
): boolean {
  const field: unknown = value[key];
  if (typeof field !== "boolean") return invalidInput(source, `${path}.${key}`, "a required boolean");
  return field;
}

/** Telegram 消息 ID 恒为正整数；0 与负数不是「没有消息」，而是坏数据。 */
function optionalMessageId(
  value: Record<string, unknown>,
  key: string,
  { source, path }: InputFieldContext
): number | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (!Number.isSafeInteger(field) || (field as number) < 1) {
    return invalidInput(source, `${path}.${key}`, "a positive safe integer message ID");
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
  const context: InputFieldContext = { source, path };
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
  const context: InputFieldContext = { source, path };
  const intentId: number | undefined = optionalTimestampField(value, "intentId", context);
  if (intentId === undefined || intentId === 0) {
    return invalidInput(source, `${path}.intentId`, "a positive safe integer");
  }
  const expiresAt: number | undefined = optionalTimestampField(value, "expiresAt", context);
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
 * 主线程接收 Worker lockdown 事件时的入站校验，校验规则与磁盘解码同源。
 *
 * ChatState 采用先写内存、再落盘的顺序；未通过校验的记录一旦写入内存，会导致
 * 该群此后所有状态写入（任何开关命令）随之抛错。校验必须在写入内存前完成，
 * 不能延后到 encodeChatStateData 才发现。
 */
export function assertPersistableLockdown(
  record: LockdownRecord,
  source: string
): void {
  decodeLockdown(record, source, "$.lockdown");
}

/** 翻译目标身份：非零安全整数 id，其余字段可选且类型严格；按固定字段顺序构造。 */
function decodeTranslatedUser(value: unknown, context: InputFieldContext): CachedUser {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CACHED_USER_KEYS)) {
    return invalidInput(context.source, context.path, "an object containing only id, username, first_name, last_name, title and isChannel");
  }
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id === 0) {
    return invalidInput(context.source, `${context.path}.id`, "a non-zero safe integer");
  }
  return {
    id: value.id,
    username: optionalStringField(value, "username", context),
    first_name: optionalStringField(value, "first_name", context),
    last_name: optionalStringField(value, "last_name", context),
    title: optionalStringField(value, "title", context),
    isChannel: optionalBooleanField(value, "isChannel", context),
  };
}

/**
 * 本群翻译会话：1 至 TRANSLATE_CHAT_USER_LIMIT 项，每项只含 translatedUser 与 language，
 * 目标身份在群内唯一，方向限定为 ja、cn、en、uk、ru。
 */
function decodeTranslateSessions(value: unknown, source: string): readonly TranslateState[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TRANSLATE_CHAT_USER_LIMIT) {
    return invalidInput(source, "$.translate", `an array containing 1 to ${TRANSLATE_CHAT_USER_LIMIT} translation sessions`);
  }
  const sessions: TranslateState[] = [];
  const userIds: Set<number> = new Set();
  for (let index: number = 0; index < value.length; index++) {
    const path: string = `$.translate[${index}]`;
    const entry: unknown = value[index];
    if (!isPlainRecord(entry) || !hasOnlyKeys(entry, TRANSLATE_SESSION_KEYS)) {
      return invalidInput(source, path, "an object containing only translatedUser and language");
    }
    const language: unknown = entry.language;
    if (language !== "ja" && language !== "cn" && language !== "en" && language !== "uk" && language !== "ru") {
      return invalidInput(source, `${path}.language`, "one of ja, cn, en, uk or ru");
    }
    const translatedUser: CachedUser = decodeTranslatedUser(entry.translatedUser, { source, path: `${path}.translatedUser` });
    if (userIds.has(translatedUser.id)) {
      return invalidInput(source, `${path}.translatedUser.id`, "unique within the chat");
    }
    userIds.add(translatedUser.id);
    sessions.push({ translatedUser, language });
  }
  return sessions;
}

/**
 * 合并并严格解码 status 与 ai_persona；未知字段、状态与人设同时为空的行均拒绝。
 * 缺省的开关解码为 false。
 */
export function decodeChatStateData(text: string, source: string, aiPersona: string | null = null): ChatState {
  const persona: string | undefined = decodeAiPersona(aiPersona, source);
  const value: unknown = parseJsonInput(text, source);
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CHAT_STATE_KEYS)) {
    return invalidInput(source, "$", "an object containing only supported chat-state fields");
  }
  const titleValue: unknown = value.title;
  if (titleValue !== undefined && typeof titleValue !== "string") {
    return invalidInput(source, "$.title", "a string");
  }
  const rootContext: InputFieldContext = { source, path: "$" };
  const state: ChatState = {
    aiPersona: persona,
    quietUntil: optionalTimestampField(value, "quietUntil", rootContext),
    lockdown: value.lockdown === undefined
      ? undefined
      : decodeLockdown(value.lockdown, source, "$.lockdown"),
    isAIChatEnabled: optionalBooleanField(value, "isAIChatEnabled", rootContext) === true,
    isTranslationEnabled: optionalBooleanField(value, "isTranslationEnabled", rootContext) === true,
    isAdDetectEnabled: optionalBooleanField(value, "isAdDetectEnabled", rootContext) === true,
    isFloodControlEnabled: optionalBooleanField(value, "isFloodControlEnabled", rootContext) === true,
    isAntiRaidEnabled: optionalBooleanField(value, "isAntiRaidEnabled", rootContext) === true,
    isInitEnabled: optionalBooleanField(value, "isInitEnabled", rootContext) === true,
    botPermissions: value.botPermissions === undefined
      ? undefined
      : decodeBotPermissions(value.botPermissions, source, "$.botPermissions"),
    title: titleValue,
    isProxySendEnabled: optionalBooleanField(value, "isProxySendEnabled", rootContext) === true,
    translate: value.translate === undefined ? undefined : decodeTranslateSessions(value.translate, source),
  };
  if (persona === undefined && Object.keys(value).length === 0) {
    return invalidInput(source, "$", "a non-empty chat-state object");
  }
  return state;
}

/** 开关为 true 时写入 true，否则省略该键。 */
function enabledOrOmitted(enabled: boolean): true | undefined {
  return enabled ? true : undefined;
}

/**
 * 编码前走同一严格解码器，非法内存状态不得进入 SQLite。字段顺序与
 * createChatState 一致；aiPersona 另存 ai_persona 列，不进入状态载荷。
 */
export function encodeChatStateData(
  state: Readonly<ChatState>,
  source: string = "chat state"
): string {
  const text: string = JSON.stringify({
    quietUntil: state.quietUntil,
    lockdown: state.lockdown,
    isAIChatEnabled: enabledOrOmitted(state.isAIChatEnabled),
    isTranslationEnabled: enabledOrOmitted(state.isTranslationEnabled),
    isAdDetectEnabled: enabledOrOmitted(state.isAdDetectEnabled),
    isFloodControlEnabled: enabledOrOmitted(state.isFloodControlEnabled),
    isAntiRaidEnabled: enabledOrOmitted(state.isAntiRaidEnabled),
    isInitEnabled: enabledOrOmitted(state.isInitEnabled),
    botPermissions: state.botPermissions,
    title: state.title,
    isProxySendEnabled: enabledOrOmitted(state.isProxySendEnabled),
    translate: state.translate,
  });
  decodeChatStateData(text, source, state.aiPersona ?? null);
  return text;
}

/** SQL NULL 表示缺省；显式空白或非法类型拒绝使用。 */
export function decodeAiPersona(value: unknown, source: string): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidInput(source, "$.ai_persona", "SQL NULL or a non-blank string");
  }
  return value;
}
