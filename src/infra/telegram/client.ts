import { Api, Bot, GrammyError } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { autoRetry } from "@grammyjs/auto-retry";
import { API_RETRY_MAX_ATTEMPTS, API_RETRY_MAX_DELAY_SECONDS } from "../../consts/telegram";
import { BOT_TOKEN } from "../config";
import { logger } from "../logger";

/** 全仓默认 Telegram 客户端，统一启用节流和瞬时错误重试。 */
export const bot: Bot = new Bot(BOT_TOKEN);
bot.api.config.use(apiThrottler());
bot.api.config.use(autoRetry({ maxRetryAttempts: API_RETRY_MAX_ATTEMPTS, maxDelaySeconds: API_RETRY_MAX_DELAY_SECONDS }));

/**
 * 入群守卫使用的独立客户端。它与普通消息发送分开排队，避免一波验证/踢人
 * 请求占满默认客户端，拖慢正常指令与 AI 回复。
 */
export const joinVerificationApi: Api = new Api(BOT_TOKEN);
joinVerificationApi.config.use(apiThrottler());
joinVerificationApi.config.use(autoRetry({ maxRetryAttempts: API_RETRY_MAX_ATTEMPTS, maxDelaySeconds: API_RETRY_MAX_DELAY_SECONDS }));

/** 统一展开 Telegram API 错误，保留 Bot API 的状态码和 description。 */
export function logApiError(action: string, error: unknown): void {
  if (error instanceof GrammyError) {
    logger.error(`Failed to ${action}: ${error.error_code} ${error.description}`);
  } else {
    logger.error(`Error trying to ${action}:`, error);
  }
}

/**
 * 构造 Bot API 文件下载 URL。返回值包含 BOT_TOKEN，调用方不得将完整 URL
 * 写入日志或放进可能被 Telegram 错误 payload 回显的字段。
 */
export function buildFileDownloadUrl(filePath: string): string {
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
}
