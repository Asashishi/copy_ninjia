import type { Bot } from "grammy";
import type { Api } from "grammy";
import { ATMOSPHERE_TEXTS } from "../consts/atmosphere";
import { getChatState, getChatStateCache } from "../infra/storage/stateStore";
import { logger } from "../infra/logger";

/**
 * 向 Telegram 注册聊天框里的命令菜单。菜单只是提示层，注册失败不应阻断
 * Bot 启动；/send 刻意不展示，它只供超级管理员在私聊中使用。
 *
 * 菜单只注册到所有群聊作用域，并清掉默认作用域：私聊按「该会话 → 所有私聊 → 默认」
 * 回落，三层都没有菜单，私聊里就不再显示一串点了也不会回复的命令（私聊命令由
 * infra/updateGate.ts 的前置网关拦下）。群聊回落到所有群聊作用域；群注册失败时不清
 * 默认作用域，群里至少还有上一版菜单。
 */
export async function registerCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(ATMOSPHERE_TEXTS.teasing.BOT_COMMANDS, { scope: { type: "all_group_chats" } });
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
