import type { CommandContext, Context } from "grammy";
import type { User } from "@grammyjs/types";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { SUPER_ADMIN_USER_ID } from "../infra/config";
import type { WhitelistPermissionKey } from "../types/whitelist";
import type { CachedUser } from "../types/chatState";
import {
  hasCommandPermission,
  isSuperAdminActor,
  resolveCommandActor,
} from "./commandActor";

/**
 * 发起人是否是 SUPER_ADMIN_USER_ID 本人。/ai_chat、/ja_copy、/init、/send
 * 共用这条身份判断本身；校验不通过时的反应（回复嘲讽 vs 保持沉默）由各自
 * 调用方决定——/send 只能私聊触发，刻意不回应非本人的探测（见
 * commands/send.ts 头注：不确认这个指令存在），跟这里其余几个群聊指令
 * 「照样回嘴，只是不执行」的风格不同，不能共用同一个「校验+回复」的
 * 一体化函数。
 */
export function isSuperAdmin(fromUser: User | undefined): boolean {
  return fromUser?.id === SUPER_ADMIN_USER_ID;
}

export interface SuperAdminToggleMessages {
  rejection: (mockerLabel: string) => string;
  usage: string;
  /** 省略时仅允许超级管理员；提供时允许拥有该项白名单权限的身份。 */
  permission?: WhitelistPermissionKey;
}

/**
 * /ai_chat、/ja_copy（开关分支）、/init、/ad_detect 共用的权限与参数校验：
 * 超级管理员恒可用；提供 messages.permission 时，白名单身份也可单独获权，
 * 省略时则保持超级管理员独占。ctx.match 还必须是 enable/disable 之一。
 */
export async function resolveSuperAdminToggleArg(
  ctx: CommandContext<Context>,
  messages: SuperAdminToggleMessages
): Promise<"enable" | "disable" | undefined> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  const isAuthorized: boolean = messages.permission === undefined
    ? isSuperAdminActor(ctx)
    : hasCommandPermission(ctx, messages.permission, true);

  if (!actor || !isAuthorized) {
    await sendCommandMessage({
      chatId,
      text: messages.rejection(actor ? formatUserLabel(actor) : "哪个杂鱼"),
      replyToMessageId: messageId,
    });
    return undefined;
  }

  const arg: string = ctx.match.trim().toLowerCase();
  if (arg !== "enable" && arg !== "disable") {
    await sendCommandMessage({ chatId, text: messages.usage, replyToMessageId: messageId });
    return undefined;
  }

  return arg;
}
