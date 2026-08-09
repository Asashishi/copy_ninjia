import type { CommandContext, Context } from "grammy";
import type { Chat, Message } from "@grammyjs/types";
import type { CachedUser } from "../types/chatState";
import type { WhitelistPermissionKey } from "../types/whitelist";
import { hasWhitelistPermission } from "../config/whitelist";
import { SUPER_ADMIN_USER_ID } from "../config/telegram";

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
 * 命令发起身份是否有某项授权。超级管理员由 config/whitelist.ts 的读取边界
 * 统一持有全部可授予的白名单权限，这里不再逐命令区分要不要放行超管；
 * 仅超级管理员可用的命令（/white、/permission 修改、/batch_kick、/init、
 * /send）走 isSuperAdminActor，不属于白名单权限键。
 */
export function hasCommandPermission(
  ctx: CommandContext<Context>,
  key: WhitelistPermissionKey
): boolean {
  const actorId: number | undefined = resolveCommandActor(ctx)?.id;
  if (actorId === undefined) return false;
  return hasWhitelistPermission(actorId, key);
}
