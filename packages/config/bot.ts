/** Bot 身份、超级管理员身份与默认通知风格的严格部署配置。 */

import { BOT_ATMOSPHERES } from "../consts/bot";
import type { Atmosphere } from "../types/atmosphere";
import { botConfigCache } from "../cache/perThread/config";
import { BOT_CONFIG_PATH } from "../consts/paths";
import { loadBotConfig } from "./botInput";
import { assertDeploymentConfigLayout } from "./layout";
import type { BotConfig } from "../types/config";

await assertDeploymentConfigLayout();
const INITIAL_BOT_CONFIG: BotConfig = await loadBotConfig();
botConfigCache.current = INITIAL_BOT_CONFIG;

/** 读取异步模块初始化已经严格校验的 Bot 配置。 */
export function getBotConfig(): BotConfig {
  const config: BotConfig | null = botConfigCache.current;
  if (config === null) {
    throw new Error(`Telegram configuration was not initialized from ${BOT_CONFIG_PATH}.`);
  }
  return config;
}

/** 本进程生效的默认文案表键；重建 Worker 时仍重放本启动快照。 */
export const BOT_ATMOSPHERE: Atmosphere = BOT_ATMOSPHERES[INITIAL_BOT_CONFIG.atmosphere];

/** Telegram Bot API token；来自 config/static/bot.json。 */
export const BOT_TOKEN: string = INITIAL_BOT_CONFIG.botToken;

/** 超级管理员 Telegram 用户 ID；来自 config/static/bot.json。 */
export const SUPER_ADMIN_USER_ID: number = INITIAL_BOT_CONFIG.superAdminUserId;
