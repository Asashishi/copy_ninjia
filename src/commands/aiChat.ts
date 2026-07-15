import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types";
import { getOrCreateChatState, saveState } from "../infra/storage";
import { sendMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { AI_CHAT_ADMIN_USER_ID } from "../infra/config";

/**
 * 处理 /ai_chat enable|disable 指令：按群开关 AI 闲聊功能（见 ChatState.isUseAIChat，
 * 缺省禁用）。仅 AI_CHAT_ADMIN_USER_ID 本人可用，不走 PRIVILEGED_USERS_ID 白名单——
 * 这是单独一批权限，其他任何人尝试都只会被嘲讽，指令本身不会执行。
 */
export async function handleAiChatCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const fromUser = ctx.from;

  if (!fromUser || fromUser.id !== AI_CHAT_ADMIN_USER_ID) {
    const mockerLabel: string = fromUser
      ? formatUserLabel({ id: fromUser.id, username: fromUser.username, first_name: fromUser.first_name })
      : "哪个杂鱼";
    await sendMessage(chatId, `就 ${mockerLabel} 也想管本天才要不要闲聊？哪来的资格呀，笨蛋♡`, messageId);
    return;
  }

  const arg: string = ctx.match.trim().toLowerCase();
  if (arg !== "enable" && arg !== "disable") {
    await sendMessage(chatId, `笨蛋，要 /ai_chat enable 还是 /ai_chat disable，说清楚呀♡`, messageId);
    return;
  }

  const state: ChatState = getOrCreateChatState(chatId);
  state.isUseAIChat = arg === "enable";
  await saveState();

  const replyText: string = arg === "enable"
    ? `哼，那本天才就赏脸在这个群闲聊几句吧，杂鱼们好好珍惜♡`
    : `本天才不想再理你们这群杂鱼了，闲聊到此为止♡`;
  await sendMessage(chatId, replyText, messageId);
}
