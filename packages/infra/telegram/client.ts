import { Api, Bot, GrammyError } from "grammy";
import type { Context } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles } from "@grammyjs/files";
import type { FileApiFlavor } from "@grammyjs/files";
import { API_RETRY_MAX_ATTEMPTS, API_RETRY_MAX_DELAY_SECONDS } from "../../consts/telegram";
import { telegramClientInitialization } from "../../cache/perThread/telegram";
import { BOT_TOKEN } from "../config";
import { logger } from "../logger";

type FirstOverloadReturn<T> = T extends {
  (...args: never[]): infer FirstReturn;
  (...args: never[]): unknown;
} ? FirstReturn : never;

/** 官方 files API flavor 中增强后的 getFile 返回值。 */
export type HydratedTelegramFile = Awaited<FirstOverloadReturn<FileApiFlavor<Api>["getFile"]>>;

/** 全仓默认 Telegram 客户端，统一启用文件结果增强、节流和瞬时错误重试。 */
export const bot: Bot<Context, FileApiFlavor<Api>> = new Bot<Context, FileApiFlavor<Api>>(BOT_TOKEN);

/**
 * 入群守卫使用的独立客户端。它与普通消息发送分开排队，避免一波验证/踢人
 * 请求占满默认客户端，拖慢正常指令与 AI 回复。
 */
export const joinVerificationApi: Api = new Api(BOT_TOKEN);

/**
 * 集中安装文件结果增强、节流和重试 transformer；其中 throttler 会创建
 * Bottleneck 心跳计时器。主进程须在取得 bot.lock 后调用；业务 Worker 则在
 * 各自启动入口调用。模块导入本身只构造尚未联网的客户端，不创建计时器，
 * 重复调用幂等。
 */
export function initTelegramClients(): void {
  if (telegramClientInitialization.current) return;
  bot.api.config.use(hydrateFiles(bot.token));
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: API_RETRY_MAX_ATTEMPTS, maxDelaySeconds: API_RETRY_MAX_DELAY_SECONDS }));
  joinVerificationApi.config.use(apiThrottler());
  joinVerificationApi.config.use(autoRetry({ maxRetryAttempts: API_RETRY_MAX_ATTEMPTS, maxDelaySeconds: API_RETRY_MAX_DELAY_SECONDS }));
  telegramClientInitialization.current = true;
}

/** 统一展开 Telegram API 错误，保留 Bot API 的状态码和 description。 */
export function logApiError(action: string, error: unknown): void {
  if (error instanceof GrammyError) {
    logger.error(`Failed to ${action}: ${error.error_code} ${error.description}`);
  } else {
    logger.error(`Error trying to ${action}:`, error);
  }
}
