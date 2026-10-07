import type { Bot } from "grammy";
import { chatAtmosphere } from "../infra/atmosphere";
import { logger } from "../infra/logger";

/**
 * 向 Telegram 注册聊天框里的命令菜单。菜单只是提示层，注册失败不阻断
 * Bot 启动；/send 不展示，它只供超级管理员在私聊中使用。
 *
 * 所有群聊作用域使用本进程生效的文案风格（见 infra/atmosphere.ts），注册成功后
 * 清除默认作用域；私聊不注册菜单，私聊命令准入由 infra/updateGate.ts 控制。
 * 注册失败保留已有默认作用域。
 */
export async function registerCommandMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(chatAtmosphere().BOT_COMMANDS, { scope: { type: "all_group_chats" } });
    await bot.api.deleteMyCommands();
  } catch (error: unknown) {
    logger.error("Failed to register bot commands menu:", error);
  }
}
