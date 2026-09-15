import type { Bot } from "grammy";
import type { Api } from "grammy";
import { ATMOSPHERE_TEXTS } from "../consts/atmosphere";
import { getChatState, getChatStateCache } from "../infra/storage/stateStore";
import { logger } from "../infra/logger";

/**
 * 向 Telegram 注册聊天框里的命令菜单。菜单只是提示层，注册失败不应阻断
 * Bot 启动；/send 刻意不展示，它只供超级管理员在私聊中使用。
 */
export async function registerCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(ATMOSPHERE_TEXTS.teasing.BOT_COMMANDS);
  } catch (error: unknown) {
    logger.error("Failed to register bot commands menu:", error);
  }
  for (const [chatId] of getChatStateCache()) await syncChatCommandMenu(bot.api, chatId);
}

/** 人设变更后更新 Telegram 群菜单；删除自定义人设时恢复默认作用域的菜单。 */
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
