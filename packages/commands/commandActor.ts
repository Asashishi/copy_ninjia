import type { CommandContext, Context } from "grammy";
import type { Chat } from "grammy/types";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { CachedUser } from "../types/chatState";
import type { CommandRejectionText } from "../types/commands";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import { chatAtmosphere } from "../infra/atmosphere";
import { hasWhitelistPermission } from "../infra/identityPolicy/whitelist";
import { sendCommandMessage } from "../infra/telegram";
import { SUPER_ADMIN_USER_ID } from "../config/bot";
import { formatActorLabel } from "../users/userLabel";
import { channelIdentity, userIdentity, visibleSenderChat } from "../users/visibleSender";

/**
 * 解析命令对外可见的发起身份。sender_chat（频道马甲/频道帖）优先于 from，
 * 否则频道白名单会被 Telegram 附带的匿名服务用户误判；普通用户则回退到 from。
 *
 * 会话身份直接取 users/visibleSender.ts 的 visibleSenderChat（两种身份的形状也取自
 * 同一模块的 channelIdentity / userIdentity）：`/qa set` 的表单在命令侧用这里记下
 * openedById，在投递侧用同一个函数算发送者，两边对不上就等于匿名管理员和频道身份
 * 永远填不了自己开的表单。命令上下文里 `ctx.from === ctx.msg.from`。
 */
export function resolveCommandActor(ctx: CommandContext<Context>): CachedUser | undefined {
  const senderChat: Chat | undefined = visibleSenderChat(ctx.msg);
  if (senderChat !== undefined) return channelIdentity(senderChat);
  const fromUser: typeof ctx.from = ctx.from;
  if (fromUser === undefined) return undefined;
  return userIdentity(fromUser);
}

/**
 * 命令发起身份是否有某项授权。超级管理员由 whitelist.ts 的读取边界
 * 统一持有全部可授予的白名单权限，这里不再逐命令区分要不要放行超管；
 * 仅超级管理员可用的命令（/permission 修改、/batch_kick、/init、/send）不属于
 * 白名单权限键；/white 的受限代加能力由 isCanWhiteOther 单独授权。
 */
export function hasCommandPermission(
  ctx: CommandContext<Context>,
  key: WhitelistPermissionKey
): boolean {
  const actorId: number | undefined = resolveCommandActor(ctx)?.id;
  if (actorId === undefined) return false;
  return hasWhitelistPermission(actorId, key);
}

/**
 * 按白名单权限键放行群命令。发起身份只解析一次：持有 permission 时原样返回它；
 * 否则（含解析不出发起身份）在本群回复命令消息发一条拒绝，文案由 rejection 按
 * 发起人标签与本群氛围文案拼出，走 sendCommandMessage 的默认 30 秒清理，并返回
 * undefined。超级管理员恒持有全部权限键（见 whitelist.ts）。
 */
export async function rejectUnlessPermitted(
  ctx: CommandContext<Context>,
  permission: WhitelistPermissionKey,
  rejection: CommandRejectionText
): Promise<CachedUser | undefined> {
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  if (actor !== undefined && hasWhitelistPermission(actor.id, permission)) return actor;
  await replyCommandRejection(ctx, actor, rejection);
  return undefined;
}

/**
 * 只放行超级管理员本人的群命令（/batch_kick、/init）；拒绝回执的形态与
 * rejectUnlessPermitted 相同。这类命令不属于白名单权限键，无法授权出去。
 */
export async function rejectUnlessSuperAdmin(
  ctx: CommandContext<Context>,
  rejection: CommandRejectionText
): Promise<CachedUser | undefined> {
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  if (actor?.id === SUPER_ADMIN_USER_ID) return actor;
  await replyCommandRejection(ctx, actor, rejection);
  return undefined;
}

/** 两道权限闸共用的拒绝回执：回复命令消息，标签解析不出时退化为「未知发起人」。 */
async function replyCommandRejection(
  ctx: CommandContext<Context>,
  actor: CachedUser | undefined,
  rejection: CommandRejectionText
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
  await sendCommandMessage({
    chatId,
    text: rejection(formatActorLabel(actor, atmosphere), atmosphere),
    replyToMessageId: ctx.msgId,
  });
}
