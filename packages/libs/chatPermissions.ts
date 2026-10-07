import type { ChatPermissions } from "grammy/types";
import { CHAT_PERMISSION_KEYS } from "../consts/storage";

/**
 * 把 Telegram 返回的群默认权限收敛成本项目持久化 schema 认识的字段集
 * （CHAT_PERMISSION_KEYS）。
 *
 * `getChat().permissions` 是平台响应，字段集由 Telegram 决定；存进 ChatState.lockdown
 * 的快照必须先经本函数收敛，再由落盘自检（database/codec/chatState.ts）严格解码。
 *
 * 只用于要存下来的那份快照（LockdownRecord.originalPermissions，恢复时只读它的
 * `can_invite_users`）。写回 Telegram 的读改写路径传原始对象：`setChatPermissions`
 * 把省略字段一律当 false（见 consts/telegram.ts 的 INDEPENDENT_CHAT_PERMISSIONS_OTHER）。
 */
export function normalizeChatPermissions(
  permissions: Readonly<ChatPermissions>
): ChatPermissions {
  const normalized: ChatPermissions = {};
  for (const key of CHAT_PERMISSION_KEYS) {
    const value: unknown = permissions[key];
    if (typeof value === "boolean") Reflect.set(normalized, key, value);
  }
  return normalized;
}
