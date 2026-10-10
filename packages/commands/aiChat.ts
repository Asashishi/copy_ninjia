import { chatAtmosphere } from "../infra/atmosphere";
import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { invalidateAiChat } from "../aiChat";
import { aiChatConfigReadiness } from "../config/readiness";

import { refuseIfConfigBroken } from "./configGate";
import { runChatToggleCommand } from "./superAdminToggle";

/**
 * 处理 /ai_chat enable|disable 指令：按群开关 AI 闲聊功能（见 ChatState.isAIChatEnabled）。
 * 仅持有 isCanControllAIPermission 的身份可用；超级管理员恒持有该权限（见 whitelist.ts），
 * 白名单身份可由 /permission 单独获权；其他身份收到拒绝回执。
 *
 * 开启前经 aiChatConfigReadiness 检查部署输入（见 config/readiness.ts），不满足则拒绝开启；
 * 关闭方向不检查。
 *
 * 关闭时调用 invalidateAiChat：使该群回复代数失效、清空 Worker 侧等候队列并删除该群 AI 记忆；
 * 在途回复返回后因代数失配停止发送。
 */
export async function handleAiChatCommand(ctx: CommandContext<Context>): Promise<void> {
  await runChatToggleCommand({
    ctx,
    texts: chatAtmosphere().AI_CHAT_TOGGLE_TEXTS,
    permission: "isCanControllAIPermission",
    persistReason: "ai_chat toggled",
    runtimeLabel: "AI chat runtime",
    read: (state: ChatState): boolean => state.isAIChatEnabled === true,
    write: (state: ChatState, isEnabled: boolean): void => {
      state.isAIChatEnabled = isEnabled;
    },
    refuseEnable: (chatId: number, messageId: number | undefined): Promise<boolean> =>
      refuseIfConfigBroken({
        readiness: aiChatConfigReadiness(),
        chatId,
        messageId,
        feature: "AI chat",
        text: (file: string): string => chatAtmosphere().NOTICE_TEXTS.aiConfigInvalid(file),
      }),
    teardown: invalidateAiChat,
  });
}
