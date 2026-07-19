import type { CommandContext, Context } from "grammy";
import type { User } from "@grammyjs/types";
import { sendMessage } from "../infra/telegram";
import { formatMockerLabel } from "../users/userLabel";
import { SUPER_ADMIN_USER_ID } from "../infra/config";

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

/**
 * /ai_chat、/ja_copy（开关分支）、/init 共用的权限与参数校验：发起人必须是
 * SUPER_ADMIN_USER_ID 本人，且 ctx.match 必须是 enable/disable 之一。任一
 * 校验不过时按对应文案回复嘲讽/用法提示并返回 undefined，调用方直接 return；
 * 全部通过时返回解析出的 arg，调用方只需处理各自的状态字段与成功文案。
 */
export async function resolveSuperAdminToggleArg(
  ctx: CommandContext<Context>,
  messages: { rejection: (mockerLabel: string) => string; usage: string }
): Promise<"enable" | "disable" | undefined> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;

  if (!isSuperAdmin(fromUser)) {
    await sendMessage(chatId, messages.rejection(formatMockerLabel(fromUser)), messageId);
    return undefined;
  }

  const arg: string = ctx.match.trim().toLowerCase();
  if (arg !== "enable" && arg !== "disable") {
    await sendMessage(chatId, messages.usage, messageId);
    return undefined;
  }

  return arg;
}
