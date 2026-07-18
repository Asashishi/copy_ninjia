import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { invalidateAiChat } from "../aiChat";
import { getOrCreateChatState, saveStateInBackground } from "../infra/storage";
import { sendMessage } from "../infra/telegram";
import { resolveSuperAdminToggleArg } from "./superAdminToggle";

/**
 * 处理 /ai_chat enable|disable 指令：按群开关 AI 闲聊功能（见 ChatState.isAIChatEnabled，
 * 缺省禁用）。仅 SUPER_ADMIN_USER_ID 本人可用，不走 PRIVILEGED_USERS_ID 白名单——
 * 这是单独一批权限，其他任何人尝试都只会被嘲讽，指令本身不会执行。
 */
export async function handleAiChatCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg = await resolveSuperAdminToggleArg(ctx, {
    rejection: (mockerLabel) => `就 ${mockerLabel} 也想管本天才要不要闲聊？哪来的资格呀，笨蛋♡`,
    usage: `笨蛋，要 /ai_chat enable 还是 /ai_chat disable，说清楚呀♡`,
  });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatId);
  state.isAIChatEnabled = arg === "enable";
  // 关闭时同步清掉 Worker 侧已排队的触发：主线程停止投喂只拦得住之后的，
  // 递增状态代数并清队列，拦截排队和在途回复的后续副作用。
  if (arg === "disable") invalidateAiChat(chatId, true);
  saveStateInBackground("ai_chat toggled");

  const replyText: string = arg === "enable"
    ? `哼，那本天才就赏脸在这个群闲聊几句吧，杂鱼们好好珍惜♡`
    : `本天才不想再理你们这群杂鱼了，闲聊到此为止♡`;
  await sendMessage(chatId, replyText, messageId);
}
