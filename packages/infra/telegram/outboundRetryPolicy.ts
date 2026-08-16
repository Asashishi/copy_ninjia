import type { RawApi } from "grammy";
import {
  TELEGRAM_429_FALLBACK_RETRY_MS,
  TELEGRAM_429_RETRY_QUEUE_MAX,
} from "../../consts/telegram";
import type { TelegramRetryCategory } from "../../types/telegramOutbound";
import type { TelegramProjectRawMethod } from "../../types/telegramWorker";
import { isTelegramMessageRequest } from "./messageThrottler";

/** 429 退避队列拒绝错误；安全动作的 durable owner 收到后保留原任务并重投。 */
export class TelegramRetryQueueFullError extends Error {
  constructor() {
    super(`Telegram 429 retry queue reached its ${TELEGRAM_429_RETRY_QUEUE_MAX} request limit.`);
    this.name = "TelegramRetryQueueFullError";
  }
}

/**
 * 按业务语义选择独立的 429 域。高频调用都走 switch 的稳定分支；前缀兜底只
 * 服务未在项目调用面出现的新 Bot API，避免它意外与已有安全动作共享冷却。
 */
export function telegramRetryCategoryFor(
  method: keyof RawApi | TelegramProjectRawMethod
): TelegramRetryCategory {
  if (method === "deleteEphemeralMessage") return "delete";
  if (isTelegramMessageRequest(method)) return "message";
  switch (method) {
    case "answerInlineQuery":
    case "answerWebAppQuery":
    case "savePreparedInlineMessage":
      return "inline";
    case "getFile":
      return "download";
    case "banChatMember":
    case "kickChatMember":
    case "banChatSenderChat":
    case "unbanChatMember":
    case "unbanChatSenderChat":
      return "kick";
    case "restrictChatMember":
    case "setChatPermissions":
    case "promoteChatMember":
    case "setChatAdministratorCustomTitle":
      return "restrict";
    case "deleteMessage":
    case "deleteMessages":
    case "deleteBusinessMessages":
      return "delete";
    case "sendChatAction":
      return "chatAction";
    case "setMessageReaction":
    case "deleteMessageReaction":
    case "deleteAllMessageReactions":
      return "reaction";
    case "answerCallbackQuery":
    case "answerPreCheckoutQuery":
    case "answerShippingQuery":
      return "callback";
    case "getChat":
    case "getChatAdministrators":
    case "getChatMember":
    case "getStickerSet":
    case "getUserProfilePhotos":
      return "query";
    default:
      break;
  }
  const name: string = method;
  if (name.startsWith("get")) return "query";
  if (name.startsWith("edit") || method === "stopPoll") return "edit";
  if (
    name.includes("ProfilePhoto") ||
    name.startsWith("setMyName") ||
    name.startsWith("setMyDescription") ||
    name.startsWith("setMyShortDescription")
  ) return "profile";
  if (
    name.startsWith("setMy") ||
    name.startsWith("deleteMy") ||
    name.includes("Webhook") ||
    name.includes("ForumTopic") ||
    name.includes("InviteLink")
  ) return "management";
  return "other";
}

/** 429 退避的下限；非正数一律回落到统一兜底值。 */
function clampRetryDelay(delayMs: number): number {
  return delayMs > 0 ? delayMs : TELEGRAM_429_FALLBACK_RETRY_MS;
}

/**
 * 从 fetch Response 或 Bot API 原始响应提取退避毫秒数；非 429 返回 undefined。
 * 空白、非法、非正或已经过去的 Retry-After 都回落到统一兜底，避免零延迟空转。
 */
export function telegramRetryAfterMilliseconds(
  response: unknown
): number | undefined {
  if (response instanceof Response) {
    if (response.status !== 429) return undefined;
    const retryAfter: string | null = response.headers.get("retry-after");
    if (retryAfter === null) return TELEGRAM_429_FALLBACK_RETRY_MS;
    const seconds: number = Number(retryAfter);
    if (retryAfter.trim().length > 0 && Number.isFinite(seconds) && seconds >= 0) {
      return clampRetryDelay(Math.ceil(seconds * 1_000));
    }
    const retryAt: number = Date.parse(retryAfter);
    return Number.isFinite(retryAt)
      ? clampRetryDelay(retryAt - Date.now())
      : TELEGRAM_429_FALLBACK_RETRY_MS;
  }
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    response.ok !== false ||
    !("error_code" in response) ||
    response.error_code !== 429
  ) return undefined;
  if (
    !("parameters" in response) ||
    typeof response.parameters !== "object" ||
    response.parameters === null ||
    !("retry_after" in response.parameters)
  ) return TELEGRAM_429_FALLBACK_RETRY_MS;
  const retryAfterSeconds: unknown = response.parameters.retry_after;
  if (
    typeof retryAfterSeconds !== "number" ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds < 0
  ) return TELEGRAM_429_FALLBACK_RETRY_MS;
  return clampRetryDelay(Math.ceil(retryAfterSeconds * 1_000));
}
