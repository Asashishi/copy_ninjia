/** 安装器与运行时共用的 Telegram 配置解码；导入时不读盘、不填充线程缓存。 */

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
    return invalidInput(sourcePath, "$", "exactly { bot_token, super_admin_user_id }");
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

/** 按指定路径读取并严格解析，不改写运行时快照。 */
export async function loadTelegramConfig(
  path: string = TELEGRAM_CONFIG_PATH
): Promise<TelegramConfig> {
  return parseTelegramConfig(await readJsonInput(path), path);
}
