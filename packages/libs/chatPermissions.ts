import type { ChatPermissions } from "grammy/types";
import { CHAT_PERMISSION_KEYS } from "../consts/storage";

/**
 * 把 Telegram 返回的群默认权限收敛成本项目持久化 schema 认识的字段集。
 *
 * `getChat().permissions` 是平台响应，字段集由 Telegram 单方面决定：Bot API
 * 新增一个权限字段，返回值里就会多出一个我们的 `chat_states` 解码器不认识的
 * 键。原样存进 ChatState.lockdown 会在落盘自检（database/codec/chatState.ts）
 * 处变成致命错误，把整轮私密模式卡在 APPLYING，并让该群此后所有状态写入一并
 * 失败。严格解码器管的是我们自己的持久化格式，平台响应必须在入口收敛。
 *
 * 只用于**要存下来的那份快照**（LockdownRecord.originalPermissions，恢复时只
 * 读它的 `can_invite_users`）。写回 Telegram 的读改写路径必须继续传原始对象：
 * `setChatPermissions` 把省略字段一律当 false，丢掉未知字段等于悄悄关掉群里
 * 一项新权限（见 consts/telegram.ts 的 INDEPENDENT_CHAT_PERMISSIONS_OTHER）。
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
