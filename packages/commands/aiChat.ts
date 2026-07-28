import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { invalidateAiChat } from "../aiChat";
import { logger } from "../infra/logger";
import { getOrCreateChatState, persistAuthoritativeState } from "../infra/storage/stateStore";
import { sendMessage } from "../infra/telegram";
import { resolveSuperAdminToggleArg } from "./superAdminToggle";

/**
 * 处理 /ai_chat enable|disable 指令：按群开关 AI 闲聊功能（见 ChatState.isAIChatEnabled，
 * 缺省禁用）。仅 SUPER_ADMIN_USER_ID 本人可用，不走 PRIVILEGED_USERS_ID 白名单——
 * 这是单独一批权限，其他任何人尝试都只会被嘲讽，指令本身不会执行。
 */
export async function handleAiChatCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg: "enable" | "disable" | undefined = await resolveSuperAdminToggleArg(ctx, {
    rejection: (mockerLabel: string): string => `就 ${mockerLabel} 也想管本天才要不要闲聊？哪来的资格呀，笨蛋♡`,
    usage: `笨蛋，要 /ai_chat enable 还是 /ai_chat disable，说清楚呀♡`,
  });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const state: ChatState = getOrCreateChatState(chatId);
  state.isAIChatEnabled = arg === "enable";
  // 关闭时同步清掉 Worker 侧已排队的触发：主线程停止投喂只拦得住之后的，
  // 递增状态代数并清队列，拦截排队和在途回复的后续副作用。
  await persistAuthoritativeState("ai_chat toggled");
  if (arg === "disable") {
    // 开关本身已经落盘，运行时清理是尽力而为：Worker 不可用（已放弃/重生中）
    // 时这里会 reject，放它逃出去就是这条 update 判失败、最终 offset 被扣住、
    // 重启后 Telegram 重投同一条 /ai_chat——而 Worker 正不可用，重投同样失败，
    // 恰好把重启循环焊死。在途回复另有 generation 自检兜底，不会因此发出。
    try {
      await invalidateAiChat(chatId, true);
    } catch (error: unknown) {
      logger.error(`Failed to invalidate the AI chat runtime of chat ${chatId} after disabling it:`, error);
    }
  }

  const replyText: string = arg === "enable"
    ? `哼，那本天才就赏脸在这个群闲聊几句吧，杂鱼们好好珍惜♡`
    : `本天才不想再理你们这群杂鱼了，闲聊到此为止♡`;
  await sendMessage({ chatId, text: replyText, replyToMessageId: messageId });
}
