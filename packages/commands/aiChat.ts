import type { CommandContext, Context } from "grammy";
import type { ChatState } from "../types/chatState";
import { invalidateAiChat } from "../aiChat";
import { aiChatConfigReadiness } from "../config/readiness";
import { AI_CHAT_TOGGLE_TEXTS } from "../consts/commands";
import { refuseIfConfigBroken } from "./configGate";
import { runChatToggleCommand } from "./superAdminToggle";

/**
 * 处理 /ai_chat enable|disable 指令：按群开关 AI 闲聊功能（见 ChatState.isAIChatEnabled，
 * 缺省禁用）。仅持有 isCanControllAIPermission 的身份可用；
 * 超级管理员恒持有该权限（见 whitelist.ts），白名单身份可由 /permission 单独获权；其他身份只会被嘲讽。
 *
 * 开启前严格检查 agent（含每项 api_key）及其它部署输入。任一不满足都拒绝——AI Worker 压根没启动，
 * 开着也永远不会有回复，不留一个看着已生效、实际什么都不做的开关。关闭方向
 * 两道都不拦：前提被破坏之后仍要能把残留的开关和记忆清干净。
 *
 * 关闭时同步清掉 Worker 侧已排队的触发：主线程停止投喂只拦得住之后的，递增
 * 状态代数并清队列才能拦截排队和在途回复的后续副作用。在途回复另有 generation
 * 自检兜底，不会因为清理失败而发出。
 */
export async function handleAiChatCommand(ctx: CommandContext<Context>): Promise<void> {
  await runChatToggleCommand({
    ctx,
    texts: AI_CHAT_TOGGLE_TEXTS,
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
        text: (file: string): string => `本天才的 ${file} 写坏了，读都读不动还闲什么聊？修好再重启，笨蛋♡`,
      }),
    teardown: (chatId: number): Promise<void> => invalidateAiChat(chatId, true),
  });
}
