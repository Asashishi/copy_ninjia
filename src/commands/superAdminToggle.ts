import type { CommandContext, Context } from "grammy";
import { sendMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { SUPER_ADMIN_USER_ID } from "../infra/config";

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

  if (!fromUser || fromUser.id !== SUPER_ADMIN_USER_ID) {
    const mockerLabel: string = fromUser
      ? formatUserLabel({ id: fromUser.id, username: fromUser.username, first_name: fromUser.first_name })
      : "哪个杂鱼";
    await sendMessage(chatId, messages.rejection(mockerLabel), messageId);
    return undefined;
  }

  const arg: string = ctx.match.trim().toLowerCase();
  if (arg !== "enable" && arg !== "disable") {
    await sendMessage(chatId, messages.usage, messageId);
    return undefined;
  }

  return arg;
}
