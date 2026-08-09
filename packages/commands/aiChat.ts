import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { invalidateAiChat } from "../aiChat";
import { aiChatConfigReadiness } from "../config/readiness";
import { AI_CHAT_TOGGLE_TEXTS } from "../consts/commands";
import { logger } from "../infra/logger";
import { getOrCreateChatState, persistAuthoritativeState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { refuseIfConfigBroken } from "./configGate";
import { resolveSuperAdminToggleArg, toggleReplyText } from "./superAdminToggle";

/**
 * 处理 /ai_chat enable|disable 指令：按群开关 AI 闲聊功能（见 ChatState.isAIChatEnabled，
 * 缺省禁用）。仅持有 isCanControllAIPermission 的身份可用；
 * 超级管理员恒持有该权限（见 config/whitelist.ts），白名单身份可由 /permission 单独获权；其他身份只会被嘲讽。
 *
 * 开启前严格检查 agent（含每项 api_key）及其它部署输入。任一不满足都拒绝——AI Worker 压根没启动，
 * 开着也永远不会有回复，不留一个看着已生效、实际什么都不做的开关。关闭方向
 * 两道都不拦：前提被破坏之后仍要能把残留的开关和记忆清干净。
 */
export async function handleAiChatCommand(ctx: CommandContext<Context>): Promise<void> {
  const arg: "enable" | "disable" | undefined = await resolveSuperAdminToggleArg(ctx, {
    texts: AI_CHAT_TOGGLE_TEXTS,
    permission: "isCanControllAIPermission",
  });
  if (!arg) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (arg === "enable") {
    const refused: boolean = await refuseIfConfigBroken({
      readiness: aiChatConfigReadiness(),
      chatId,
      messageId,
      feature: "AI chat",
      text: (file: string): string => `本天才的 ${file} 写坏了，读都读不动还闲什么聊？修好再重启，笨蛋♡`,
    });
    if (refused) return;
  }
  const state: ChatState = getOrCreateChatState(chatId);
  const wasEnabled: boolean = state.isAIChatEnabled === true;
  const isEnabled: boolean = arg === "enable";
  state.isAIChatEnabled = isEnabled;
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

  const replyText: string = toggleReplyText({
    isEnabled,
    wasEnabled,
    texts: AI_CHAT_TOGGLE_TEXTS,
  });
  await sendCommandMessage({ chatId, text: replyText, replyToMessageId: messageId });
}
