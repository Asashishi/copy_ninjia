/** 安装器与运行时共用的 Bot 配置解码；导入时不读盘、不填充线程缓存。 */

import { DEFAULT_BOT_ATMOSPHERE } from "../consts/bot";
import { BOT_CONFIG_PATH } from "../consts/paths";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../consts/telegram";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
import type { BotConfig } from "../types/config";

/** 解码 config/static/bot.json；未知字段、空 token 与非法 ID 一律拒绝。 */
export function parseBotConfig(
  value: unknown,
  sourcePath: string = BOT_CONFIG_PATH
): BotConfig {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["bot_token", "super_admin_user_id", "atmosphere"])) {
    return invalidInput(sourcePath, "$", "{ bot_token, super_admin_user_id, atmosphere?: mesugaki | normal }");
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
  if (value.atmosphere !== undefined && value.atmosphere !== "mesugaki" && value.atmosphere !== "normal") {
    return invalidInput(sourcePath, "$.atmosphere", "mesugaki or normal");
  }
  return {
    atmosphere: value.atmosphere ?? DEFAULT_BOT_ATMOSPHERE,
    botToken: value.bot_token.trim(),
    superAdminUserId: value.super_admin_user_id,
  };
}

/** 按指定路径读取并严格解析，不改写运行时快照；目录布局由 config/layout.ts 另行检查。 */
export async function loadBotConfig(
  path: string = BOT_CONFIG_PATH
): Promise<BotConfig> {
  return parseBotConfig(await readJsonInput(path), path);
}
