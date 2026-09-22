import type { Bot } from "grammy";
import type { Api } from "grammy";
import { BOT_ATMOSPHERE } from "../config/bot";
import { ATMOSPHERE_TEXTS } from "../consts/atmosphere";
import { getChatState, getChatStateCache } from "../infra/storage/stateStore";
import { logger } from "../infra/logger";

/**
 * 向 Telegram 注册聊天框里的命令菜单。菜单只是提示层，注册失败不应阻断
 * Bot 启动；/send 刻意不展示，它只供超级管理员在私聊中使用。
 *
 * 所有群聊作用域使用 Bot 配置语气；有自定义人设的群另设普通版作用域。
 * 全群菜单注册成功后清除默认作用域，私聊不注册菜单；私聊命令准入由
 * infra/updateGate.ts 控制。注册失败保留已有默认作用域，各群同步仍继续执行。
 */
export async function registerCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(ATMOSPHERE_TEXTS[BOT_ATMOSPHERE].BOT_COMMANDS, { scope: { type: "all_group_chats" } });
    await bot.api.deleteMyCommands();
  } catch (error: unknown) {
    logger.error("Failed to register bot commands menu:", error);
  }
  for (const [chatId] of getChatStateCache()) await syncChatCommandMenu(bot.api, chatId);
}

/** 人设变更后更新 Telegram 群菜单；删除自定义人设时删掉本群作用域，回落到所有群聊作用域的菜单。 */
export async function syncChatCommandMenu(
  api: Pick<Api, "setMyCommands" | "deleteMyCommands">,
  chatId: number
): Promise<void> {
  try {
    if (getChatState(chatId).aiPersona === undefined) {
      await api.deleteMyCommands({ scope: { type: "chat", chat_id: chatId } });
    } else {
      await api.setMyCommands(ATMOSPHERE_TEXTS.plain.BOT_COMMANDS, { scope: { type: "chat", chat_id: chatId } });
    }
  } catch (error: unknown) {
    logger.error(`Failed to synchronize the commands menu for chat ${chatId}:`, error);
  }
}
