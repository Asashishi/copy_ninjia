import type { ChatPermissions } from "@grammyjs/types";
import { CHAT_PERMISSION_KEYS } from "../consts/storage";
import type { AiProviderName } from "../types/aiChat/provider";
import type {
  CachedUser,
  ChatState,
  CopyMode,
  GlobalCopyState,
  GlobalModelState,
  GlobalState,
  LockdownRecord,
  StateFileSchema,
} from "../types/chatState";

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

/**
 * 模型选取值（生图与闲聊两项共用）。口径与其余字段一致：缺省即从没设过，存在
 * 但非法拒绝整份文件——静默丢掉它等于让超管以为切过了、实际还在用默认供应商。
 */
function providerName(value: unknown, path: string): AiProviderName | undefined {
  if (value === undefined) return undefined;
  if (value === "gemini" || value === "openai") return value;
  throw new Error(`${path} must be one of gemini or openai`);
}

function cachedUser(value: unknown, path: string): CachedUser {
  const raw: Record<string, unknown> = record(value, path);
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

function chatPermissions(value: unknown, path: string): ChatPermissions {
  const raw: Record<string, unknown> = record(value, path);
  knownKeys(raw, CHAT_PERMISSION_KEYS, path);
  const decoded: ChatPermissions = {};
  for (const key of CHAT_PERMISSION_KEYS) {
    const field: unknown = raw[key];
    if (field === undefined) continue;
    if (typeof field !== "boolean") throw new Error(`${path}.${key} must be a boolean`);
    Reflect.set(decoded, key, field);
  }
  return decoded;
}

function lockdown(value: unknown, path: string): LockdownRecord {
  const raw: Record<string, unknown> = record(value, path);
  knownKeys(raw, ["phase", "intentId", "originalPermissions", "expiresAt"], path);
  const expiresAt: number | undefined = optionalTimestamp(raw, "expiresAt", path);
  if (expiresAt === undefined) throw new Error(`${path}.expiresAt is required`);
  const phase: unknown = raw.phase;
  if (phase !== "applying" && phase !== "active" && phase !== "restoring") {
    throw new Error(`${path}.phase is required and must be applying, active or restoring`);
  }
  const intentId: number | undefined = optionalTimestamp(raw, "intentId", path);
  if (intentId === undefined || intentId === 0) {
    throw new Error(`${path}.intentId must be a positive safe integer`);
  }
  return {
    phase,
    intentId,
    originalPermissions: chatPermissions(raw.originalPermissions, `${path}.originalPermissions`),
    expiresAt,
  };
}

function chatState(value: unknown, path: string): ChatState {
  const raw: Record<string, unknown> = record(value, path);
  knownKeys(raw, [
    "quietUntil", "lockdown", "isAIChatEnabled", "isJATranslationEnabled",
    "isAdDetectEnabled", "isFloodControlEnabled", "isInitEnabled", "botIsAdmin",
    "title", "isProxySendEnabled",
  ], path);
  return {
    quietUntil: optionalTimestamp(raw, "quietUntil", path),
    lockdown: raw.lockdown === undefined ? undefined : lockdown(raw.lockdown, `${path}.lockdown`),
    isAIChatEnabled: optionalBoolean(raw, "isAIChatEnabled", path),
    isJATranslationEnabled: optionalBoolean(raw, "isJATranslationEnabled", path),
    isAdDetectEnabled: optionalBoolean(raw, "isAdDetectEnabled", path),
    isFloodControlEnabled: optionalBoolean(raw, "isFloodControlEnabled", path),
    isInitEnabled: optionalBoolean(raw, "isInitEnabled", path),
    botIsAdmin: optionalBoolean(raw, "botIsAdmin", path),
    title: optionalString(raw, "title", path),
    isProxySendEnabled: optionalBoolean(raw, "isProxySendEnabled", path),
  };
}

function globalCopy(value: unknown): GlobalCopyState {
  const path: string = "state.global.copy";
  const raw: Record<string, unknown> = record(value, path);
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

/**
 * 全局模型选取。整块缺省按「两项都没设过」处理——手工迁移过来的文件只写了
 * copy 一块也能读回，而不是逼运维补一个空对象；块内字段存在但非法照旧拒绝
 * 整份文件。
 */
function globalModel(value: unknown): GlobalModelState {
  const path: string = "state.global.model";
  // 两条分支返回同一组字段：decodeStateFile 每次 save 都要跑一遍自校验
  // （见 infra/storage/stateStore.ts 的 save），返回值 shape 不该在两条分支间摇摆。
  if (value === undefined) return { image: undefined, chat: undefined };
  const raw: Record<string, unknown> = record(value, path);
  knownKeys(raw, ["image", "chat"], path);
  return {
    image: providerName(raw.image, `${path}.image`),
    chat: providerName(raw.chat, `${path}.chat`),
  };
}

/** 所有群共用的那一块；copy 必填，model 可缺省。 */
function globalState(value: unknown): GlobalState {
  const path: string = "state.global";
  const raw: Record<string, unknown> = record(value, path);
  knownKeys(raw, ["copy", "model"], path);
  if (!("copy" in raw)) throw new Error(`${path}.copy is required`);
  return {
    copy: globalCopy(raw.copy),
    model: globalModel(raw.model),
  };
}

/** 解码完整 state.json；任何存在但非法的字段都会拒绝整个文件。 */
export function decodeStateFile(value: unknown): StateFileSchema {
  const raw: Record<string, unknown> = record(value, "state");
  // 旧顶层键（globalCopy/imageProvider/chatProvider）会在这里被当场拒绝：结构
  // 变更只做手工迁移，解码器不留兼容分支（见 types/chatState.ts 的 StateFileSchema）。
  knownKeys(raw, ["chats", "global"], "state");
  if (!("global" in raw)) throw new Error("state.global is required");
  const rawChats: Record<string, unknown> = record(raw.chats, "state.chats");
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
  return { chats, global: globalState(raw.global) };
}
