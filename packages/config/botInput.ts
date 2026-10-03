/** 安装器与运行时共用的 Bot 配置解码；导入时不读盘、不填充线程缓存。 */

import { DEFAULT_BOT_TIME_ZONE } from "../consts/bot";
import { BOT_CONFIG_PATH } from "../consts/paths";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../consts/telegram";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
import type { BotConfig } from "../types/config";
import { parseTimeZone } from "./timeZoneInput";

/** 解码 config/static/bot.json；风格缺省保持未配置，未知字段及非法身份、风格和时区一律拒绝。 */
export function parseBotConfig(
  value: unknown,
  sourcePath: string = BOT_CONFIG_PATH
): BotConfig {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["bot_token", "super_admin_user_id", "atmosphere", "time_zone"])) {
    return invalidInput(sourcePath, "$", "{ bot_token, super_admin_user_id, atmosphere?: mesugaki | normal, time_zone?: IANA time zone }");
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
  const atmosphere: unknown = typeof value.atmosphere === "string" ? value.atmosphere.trim() : value.atmosphere;
  if (atmosphere !== undefined && atmosphere !== "mesugaki" && atmosphere !== "normal") {
    return invalidInput(sourcePath, "$.atmosphere", "mesugaki or normal");
  }
  return {
    atmosphere,
    botToken: value.bot_token.trim(),
    superAdminUserId: value.super_admin_user_id,
    timeZone: parseTimeZone(value.time_zone === undefined ? DEFAULT_BOT_TIME_ZONE : value.time_zone, sourcePath, "$.time_zone"),
  };
}

/** 按指定路径读取并严格解析，不改写运行时快照；目录布局由 config/layout.ts 另行检查。 */
export async function loadBotConfig(
  path: string = BOT_CONFIG_PATH
): Promise<BotConfig> {
  return parseBotConfig(await readJsonInput(path), path);
}
