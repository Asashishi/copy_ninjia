import type { ChatPermissions } from "@grammyjs/types";
import type { CachedUser, ChatState, CopyMode, GlobalCopyState, LockdownRecord, StateFileSchema } from "../types";

/**
 * state.json 当前 schema 的纯解码器。本模块不执行 I/O；所有持久化字段都从
 * unknown 逐项收窄，未知字段、类型错误和跨字段不变量冲突会拒绝整个文件。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const keys: Set<string> = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`${path}.${key} is not part of the current state schema`);
  }
}

function optionalBoolean(value: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "boolean") throw new Error(`${path}.${key} must be a boolean`);
  return field;
}

function optionalString(value: Record<string, unknown>, key: string, path: string): string | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string") throw new Error(`${path}.${key} must be a string`);
  return field;
}

function optionalTimestamp(value: Record<string, unknown>, key: string, path: string): number | undefined {
  const field: unknown = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`${path}.${key} must be a non-negative safe integer timestamp`);
  }
  return field;
}

function copyMode(value: unknown, path: string): CopyMode | undefined {
  if (value === undefined) return undefined;
  if (value === "reverse" || value === "nya" || value === "ja") return value;
  throw new Error(`${path} must be one of reverse, nya or ja`);
}

function cachedUser(value: unknown, path: string): CachedUser {
  const raw = record(value, path);
  knownKeys(raw, ["id", "username", "first_name", "last_name", "title", "isChannel"], path);
  if (typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || raw.id === 0) {
    throw new Error(`${path}.id must be a non-zero safe integer`);
  }
  return {
    id: raw.id,
    username: optionalString(raw, "username", path),
    first_name: optionalString(raw, "first_name", path),
    last_name: optionalString(raw, "last_name", path),
    title: optionalString(raw, "title", path),
    isChannel: optionalBoolean(raw, "isChannel", path),
  };
}

const CHAT_PERMISSION_KEYS: Record<keyof ChatPermissions, true> = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_react_to_messages: true,
  can_change_info: true,
  can_invite_users: true,
  can_edit_tag: true,
  can_pin_messages: true,
  can_manage_topics: true,
};

function chatPermissions(value: unknown, path: string): ChatPermissions {
  const raw = record(value, path);
  knownKeys(raw, Object.keys(CHAT_PERMISSION_KEYS), path);
  const decoded: ChatPermissions = {};
  let count: number = 0;
  for (const key of Object.keys(CHAT_PERMISSION_KEYS) as (keyof ChatPermissions)[]) {
    const field: unknown = raw[key];
    if (field === undefined) continue;
    if (typeof field !== "boolean") throw new Error(`${path}.${key} must be a boolean`);
    Reflect.set(decoded, key, field);
    count++;
  }
  if (count === 0) throw new Error(`${path} must contain at least one permission field`);
  return decoded;
}

function lockdown(value: unknown, path: string): LockdownRecord {
  const raw = record(value, path);
  knownKeys(raw, ["originalPermissions", "expiresAt"], path);
  const expiresAt: number | undefined = optionalTimestamp(raw, "expiresAt", path);
  if (expiresAt === undefined) throw new Error(`${path}.expiresAt is required`);
  return {
    originalPermissions: chatPermissions(raw.originalPermissions, `${path}.originalPermissions`),
    expiresAt,
  };
}

function chatState(value: unknown, path: string): ChatState {
  const raw = record(value, path);
  knownKeys(raw, [
    "quietUntil", "lockdown", "isAIChatEnabled", "isJATranslationEnabled",
    "isInitEnabled", "botIsAdmin", "title", "isProxySendEnabled",
  ], path);
  return {
    quietUntil: optionalTimestamp(raw, "quietUntil", path),
    lockdown: raw.lockdown === undefined ? undefined : lockdown(raw.lockdown, `${path}.lockdown`),
    isAIChatEnabled: optionalBoolean(raw, "isAIChatEnabled", path),
    isJATranslationEnabled: optionalBoolean(raw, "isJATranslationEnabled", path),
    isInitEnabled: optionalBoolean(raw, "isInitEnabled", path),
    botIsAdmin: optionalBoolean(raw, "botIsAdmin", path),
    title: optionalString(raw, "title", path),
    isProxySendEnabled: optionalBoolean(raw, "isProxySendEnabled", path),
  };
}

function globalCopy(value: unknown): GlobalCopyState {
  const path: string = "state.globalCopy";
  const raw = record(value, path);
  knownKeys(raw, ["lastCopyTime", "copiedUser", "copyMode", "copyChatId"], path);
  if (!("copiedUser" in raw)) throw new Error(`${path}.copiedUser is required`);
  const lastCopyTime: number | undefined = optionalTimestamp(raw, "lastCopyTime", path);
  if (raw.copiedUser === null) {
    if (raw.copyMode !== undefined || raw.copyChatId !== undefined) {
      throw new Error(`${path} cannot contain copyMode/copyChatId without copiedUser`);
    }
    return { copiedUser: null, lastCopyTime };
  }
  if (typeof raw.copyChatId !== "number" || !Number.isSafeInteger(raw.copyChatId) || raw.copyChatId === 0) {
    throw new Error(`${path}.copyChatId must be a non-zero safe integer when copiedUser is set`);
  }
  return {
    lastCopyTime,
    copiedUser: cachedUser(raw.copiedUser, `${path}.copiedUser`),
    copyMode: copyMode(raw.copyMode, `${path}.copyMode`),
    copyChatId: raw.copyChatId,
  };
}

/** 解码完整 state.json；任何存在但非法的字段都会拒绝整个文件。 */
export function decodeStateFile(value: unknown): StateFileSchema {
  const raw = record(value, "state");
  knownKeys(raw, ["chats", "globalCopy"], "state");
  const rawChats = record(raw.chats, "state.chats");
  const chats: Record<string, ChatState> = {};
  const activeProxyChatIds: number[] = [];
  for (const [chatIdText, value] of Object.entries(rawChats)) {
    const chatId: number = Number(chatIdText);
    if (!Number.isSafeInteger(chatId) || chatId === 0 || String(chatId) !== chatIdText) {
      throw new Error(`state.chats has invalid chat id key: ${chatIdText}`);
    }
    const decodedChatState: ChatState = chatState(value, `state.chats.${chatIdText}`);
    chats[chatIdText] = decodedChatState;
    if (decodedChatState.isProxySendEnabled === true) activeProxyChatIds.push(chatId);
  }
  if (activeProxyChatIds.length > 1) {
    throw new Error(`state.chats has multiple active proxy send targets: ${activeProxyChatIds.join(", ")}`);
  }
  return { chats, globalCopy: globalCopy(raw.globalCopy) };
}
