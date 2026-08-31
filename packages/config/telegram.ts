/** Telegram Bot 身份与超级管理员身份的严格部署配置。 */

import { telegramConfigCache } from "../cache/perThread/config";
import { TELEGRAM_CONFIG_PATH } from "../consts/paths";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../consts/telegram";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../libs/record";
import type { TelegramConfig } from "../types/config";

/** 解码 config/telegram.json；未知字段、空 token 与非法 ID 一律拒绝。 */
export function parseTelegramConfig(
  value: unknown,
  sourcePath: string = TELEGRAM_CONFIG_PATH
): TelegramConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["bot_token", "super_admin_user_id"])) {
    return invalidInput(
      sourcePath,
      "$",
      "exactly { bot_token, super_admin_user_id }"
    );
  }
  if (
    typeof value.bot_token !== "string" ||
    value.bot_token.trim().length === 0 ||
    value.bot_token.trim() === TELEGRAM_BOT_TOKEN_PLACEHOLDER
  ) {
    return invalidInput(sourcePath, "$.bot_token", "a configured non-placeholder string");
  }
  if (
    typeof value.super_admin_user_id !== "number" ||
    !Number.isSafeInteger(value.super_admin_user_id) ||
    value.super_admin_user_id <= 0
  ) {
    return invalidInput(sourcePath, "$.super_admin_user_id", "a positive safe integer");
  }
  return {
    botToken: value.bot_token.trim(),
    superAdminUserId: value.super_admin_user_id,
  };
}

/** 从指定路径读取并严格解析 Telegram 部署配置。 */
async function loadTelegramConfig(
  path: string = TELEGRAM_CONFIG_PATH
): Promise<TelegramConfig> {
  return parseTelegramConfig(await readJsonInput(path), path);
}

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
