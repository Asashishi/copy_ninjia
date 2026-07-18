import type { Bot } from "grammy";
import { logger } from "../infra/logger";

const BOT_COMMANDS = [
  { command: "copy", description: "复读" },
  { command: "r_copy", description: "复读并反转文本" },
  { command: "nya_copy", description: "复读并加喵~" },
  { command: "ja_copy", description: "复读并翻译为日语；enable/disable 开关本群该功能（仅限定用户可用）" },
  { command: "stop_copy", description: "停止当前的复读" },
  { command: "steal_icon", description: "偷取目标头像作为 bot 头像" },
  { command: "kick", description: "在所有本天才管理的群里踢出并封禁（仅白名单用户可用）" },
  { command: "ai_chat", description: "开关本群 AI 闲聊功能，enable/disable（仅限定用户可用）" },
  { command: "init", description: "开关本群的机器人监听/初始化，enable/disable（仅限定用户可用）" },
  { command: "quiet", description: "让机器人安静一会（分钟数 1~15，默认 3）" },
  { command: "unquiet", description: "提前解除 /quiet 静默" },
] as const;

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
