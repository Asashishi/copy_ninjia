/** Telegram Bot 身份与超级管理员身份的严格部署配置。 */

import { telegramConfigCache } from "../cache/perThread/config";
import { TELEGRAM_CONFIG_PATH } from "../consts/paths";
import { loadTelegramConfig } from "./telegramInput";
import type { TelegramConfig } from "../types/config";

const INITIAL_TELEGRAM_CONFIG: TelegramConfig = await loadTelegramConfig();
telegramConfigCache.current = INITIAL_TELEGRAM_CONFIG;

/** 读取异步模块初始化已经严格校验的 Telegram 配置。 */
export function getTelegramConfig(): TelegramConfig {
  const config: TelegramConfig | null = telegramConfigCache.current;
  if (config === null) {
    throw new Error(`Telegram configuration was not initialized from ${TELEGRAM_CONFIG_PATH}.`);
  }
  return config;
}

/** Telegram Bot API token；来自 config/telegram.json。 */
export const BOT_TOKEN: string = INITIAL_TELEGRAM_CONFIG.botToken;

/** 超级管理员 Telegram 用户 ID；来自 config/telegram.json。 */
export const SUPER_ADMIN_USER_ID: number = INITIAL_TELEGRAM_CONFIG.superAdminUserId;
