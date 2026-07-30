import type { CommandContext, Context } from "grammy";
import type { Chat, Message } from "@grammyjs/types";
import type { CachedUser } from "../types/chatState";
import type { WhitelistPermissionKey } from "../types/whitelist";
import { hasWhitelistPermission } from "../config/whitelist";
import { SUPER_ADMIN_USER_ID } from "../infra/config";

/**
 * 解析命令对外可见的发起身份。sender_chat（频道马甲/频道帖）优先于 from，
 * 否则频道白名单会被 Telegram 附带的匿名服务用户误判；普通用户则回退到 from。
 */
export function resolveCommandActor(ctx: CommandContext<Context>): CachedUser | undefined {
  const message: Message | undefined = ctx.msg;
  const senderChat: Chat | undefined =
    message?.sender_chat ?? (ctx.chat.type === "channel" ? ctx.chat : undefined);
  if (senderChat !== undefined) {
    return {
      id: senderChat.id,
      username: "username" in senderChat ? senderChat.username : undefined,
      title: "title" in senderChat ? senderChat.title : undefined,
      isChannel: true,
    };
  }
  const fromUser: typeof ctx.from = ctx.from;
  if (fromUser === undefined) return undefined;
  return {
    id: fromUser.id,
    username: fromUser.username,
    first_name: fromUser.first_name,
    last_name: fromUser.last_name,
  };
}

/** 命令的可见发起身份是否为超级管理员本人。 */
export function isSuperAdminActor(ctx: CommandContext<Context>): boolean {
  return resolveCommandActor(ctx)?.id === SUPER_ADMIN_USER_ID;
}

/**
 * 命令发起身份是否有某项授权。allowSuperAdmin 用于保持既有超管权限：
 * 开关类命令与 /unblock 放行，/block、/mute 等原本只认白名单的命令不自动扩大。
 */
export function hasCommandPermission(
  ctx: CommandContext<Context>,
  key: WhitelistPermissionKey,
  allowSuperAdmin: boolean
): boolean {
  const actorId: number | undefined = resolveCommandActor(ctx)?.id;
  if (actorId === undefined) return false;
  return (allowSuperAdmin && actorId === SUPER_ADMIN_USER_ID) ||
    hasWhitelistPermission(actorId, key);
}
