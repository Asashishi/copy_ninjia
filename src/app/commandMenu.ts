import type { Bot } from "grammy";
import { BOT_COMMANDS } from "../consts/commands";
import { logger } from "../infra/logger";

/**
 * 向 Telegram 注册聊天框里的命令菜单。菜单只是提示层，注册失败不应阻断
 * Bot 启动；/send 刻意不展示，它只供超级管理员在私聊中使用。
 */
export async function registerCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(BOT_COMMANDS);
  } catch (error: unknown) {
    logger.error("Failed to register bot commands menu:", error);
  }
}
