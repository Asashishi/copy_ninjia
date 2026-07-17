/**
 * state.json 当前 schema 的纯解码与字段校验。
 *
 * 本模块不读写文件、不持有运行时状态：只负责把 JSON.parse 产生的 unknown
 * 逐字段收窄成领域类型。Telegram 权限字段白名单属于持久化 schema，而不是
 * lockdown 状态转换规则，因此与其它 codec 逻辑集中在这里。
 */

import type { ChatPermissions } from "@grammyjs/types";
import type { CachedUser, ChatState, CopyMode, LockdownRecord } from "../types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

export function rebuildCachedUser(value: unknown): CachedUser | null {
  if (!isRecord(value)) return null;
  const id: number | undefined = finiteNumber(value.id);
  if (id === undefined || !Number.isSafeInteger(id)) return null;
  return {
    id,
    username: optionalString(value, "username"),
    first_name: optionalString(value, "first_name"),
    last_name: optionalString(value, "last_name"),
    title: optionalString(value, "title"),
    isChannel: booleanValue(value.isChannel),
  };
}

/**
 * Telegram ChatPermissions 的持久化字段白名单。Record<keyof ..., true> 刻意
 * 要求穷举：SDK 新增权限字段时编译会失败，迫使这里同步审查恢复语义。
 */
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

export function rebuildChatPermissions(value: unknown): ChatPermissions | null {
  if (!isRecord(value)) return null;
  const permissions: ChatPermissions = {};
  let found: boolean = false;
  for (const key of Object.keys(CHAT_PERMISSION_KEYS) as (keyof ChatPermissions)[]) {
    const field: unknown = value[key];
    if (typeof field === "boolean") {
      Reflect.set(permissions, key, field);
      found = true;
    }
  }
  // 空对象不能当成可恢复权限：Telegram 会把省略的发送权限视作 false，
  // 解锁时写回 {} 可能把整群永久禁言。
  return found ? permissions : null;
}

export function rebuildLockdown(value: unknown): LockdownRecord | undefined {
  if (!isRecord(value)) return undefined;
  const permissions: ChatPermissions | null = rebuildChatPermissions(value.originalPermissions);
  const expiresAt: number | undefined = finiteNumber(value.expiresAt);
  if (!permissions || expiresAt === undefined) return undefined;
  return { originalPermissions: permissions, expiresAt };
}

export function rebuildChatState(value: unknown): ChatState | null {
  if (!isRecord(value)) return null;
  return {
    quietUntil: finiteNumber(value.quietUntil),
    lockdown: rebuildLockdown(value.lockdown),
    isUseAIChat: booleanValue(value.isUseAIChat),
    isJATranslationEnabled: booleanValue(value.isJATranslationEnabled),
    isInit: booleanValue(value.isInit),
    botIsAdmin: booleanValue(value.botIsAdmin),
    title: optionalString(value, "title"),
    isUseProxySend: booleanValue(value.isUseProxySend),
  };
}

export function copyModeValue(value: unknown): CopyMode | undefined {
  return value === "reverse" || value === "nya" || value === "ja" ? value : undefined;
}
