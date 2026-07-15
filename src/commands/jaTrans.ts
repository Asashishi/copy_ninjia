import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types";
import { getOrCreateChatState, saveState } from "../infra/storage";
import { sendMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { SUPER_ADMIN_USER_ID } from "../infra/config";

/**
 * 处理 /ja_trans enable|disable 指令：按群开关 /ja_copy 的日语翻译功能（见
 * ChatState.isJATranslationEnabled，缺省启用）。仅 SUPER_ADMIN_USER_ID 本人
 * 可用，不走 PRIVILEGED_USERS_ID 白名单——与 /ai_chat 共用同一批权限。
 */
export async function handleJaTransCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;

  if (!fromUser || fromUser.id !== SUPER_ADMIN_USER_ID) {
    const mockerLabel: string = fromUser
      ? formatUserLabel({ id: fromUser.id, username: fromUser.username, first_name: fromUser.first_name })
      : "哪个杂鱼";
    await sendMessage(chatId, `就 ${mockerLabel} 也想管本天才要不要翻译日语？哪来的资格呀，笨蛋♡`, messageId);
    return;
  }

  const arg: string = ctx.match.trim().toLowerCase();
  if (arg !== "enable" && arg !== "disable") {
    await sendMessage(chatId, `笨蛋，要 /ja_trans enable 还是 /ja_trans disable，说清楚呀♡`, messageId);
    return;
  }

  const state: ChatState = getOrCreateChatState(chatId);
  state.isJATranslationEnabled = arg === "enable";
  await saveState();

  const replyText: string = arg === "enable"
    ? `哼，那本天才就赏脸继续在这个群用 /ja_copy 翻译日语吧，杂鱼们好好珍惜♡`
    : `本天才不想再给你们这群杂鱼翻译日语了，/ja_copy 到此为止♡`;
  await sendMessage(chatId, replyText, messageId);
}
