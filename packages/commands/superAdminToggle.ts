import type { CommandContext, Context } from "grammy";
import type { User } from "@grammyjs/types";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { SUPER_ADMIN_USER_ID } from "../config/telegram";
import type { WhitelistPermissionKey } from "../types/whitelist";
import type { CachedUser } from "../types/chatState";
import type { ToggleCommandTexts } from "../types/commands";
import {
  hasCommandPermission,
  isSuperAdminActor,
  resolveCommandActor,
} from "./commandActor";

/**
 * 发起人是否是 SUPER_ADMIN_USER_ID 本人。当前只有 /send 用它：它是唯一以
 * `ctx.from` 而非命令可见发起身份判定的入口——私聊里没有频道马甲，也不该让
 * sender_chat 参与。其余仅超管命令走 isSuperAdminActor（见 commandActor.ts）。
 *
 * 校验不通过时的反应也刻意不收进这里：/send 只能私聊触发，对非本人的探测保持
 * 沉默、不确认这个指令存在（见 commands/send.ts 头注），与群聊指令「照样回嘴，
 * 只是不执行」的风格不同，不能共用同一个「校验+回复」的一体化函数。
 */
export function isSuperAdmin(fromUser: User | undefined): boolean {
  return fromUser?.id === SUPER_ADMIN_USER_ID;
}

/** resolveSuperAdminToggleArg 的入参；只服务本文件那一个函数，不对外导出。 */
interface SuperAdminToggleOptions {
  /** 本命令的文案表，取自 consts/commands.ts。 */
  readonly texts: ToggleCommandTexts;
  /** 省略时仅允许超级管理员；提供时允许拥有该项白名单权限的身份。 */
  readonly permission?: WhitelistPermissionKey;
}

/** toggleReplyText 的入参；只服务本文件那一个函数，不对外导出。 */
interface ToggleReplyTextParams {
  /** 本次命令写入的目标状态。 */
  readonly isEnabled: boolean;
  /** 写入之前这个群的状态，用来识别同状态重复执行。 */
  readonly wasEnabled: boolean;
  /** 本命令的文案表；这里只取四种状态结局那四项。 */
  readonly texts: ToggleCommandTexts;
}

/**
 * 按「目标状态」与「原状态」选出开关命令的回执文案。
 *
 * 判定只看这两个布尔值，不看落盘或运行时清理是否执行过：同状态重复执行仍会
 * 照常落盘并重跑清理（那正是上一次清理失败后最自然的手工重试路径，理由同
 * commands/block.ts 里重复 /block 仍补投落盘），但回执必须如实说它没改变什么。
 */
export function toggleReplyText({
  isEnabled,
  wasEnabled,
  texts,
}: ToggleReplyTextParams): string {
  if (isEnabled === wasEnabled) {
    return isEnabled ? texts.alreadyEnabled : texts.alreadyDisabled;
  }
  return isEnabled ? texts.enabled : texts.disabled;
}

/**
 * /ai_chat、/ja_copy（开关分支）、/init、/ad_detect、/flood_control 共用的权限与参数校验。
 *
 * 提供 permission 时按该权限键授权；超级管理员恒持有全部权限键（见
 * config/whitelist.ts），因此不必也不该在这里再判一次身份。省略 permission 则是
 * 「只认身份、无法授权出去」的一类（当前只有 /init），走 isSuperAdminActor。
 * ctx.match 还必须是 enable/disable 之一。
 */
export async function resolveSuperAdminToggleArg(
  ctx: CommandContext<Context>,
  { texts, permission }: SuperAdminToggleOptions
): Promise<"enable" | "disable" | undefined> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  const isAuthorized: boolean = permission === undefined
    ? isSuperAdminActor(ctx)
    : hasCommandPermission(ctx, permission);

  if (!actor || !isAuthorized) {
    await sendCommandMessage({
      chatId,
      text: texts.rejection(actor ? formatUserLabel(actor) : "哪个杂鱼"),
      replyToMessageId: messageId,
    });
    return undefined;
  }

  const arg: string = ctx.match.trim().toLowerCase();
  if (arg !== "enable" && arg !== "disable") {
    await sendCommandMessage({ chatId, text: texts.usage, replyToMessageId: messageId });
    return undefined;
  }

  return arg;
}
