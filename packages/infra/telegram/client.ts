import { telegramApiState } from "../../cache/perThread/telegramApi";
import { logger } from "../logger";
import { telegramErrorDetails } from "./errors";
import type { TelegramApi } from "../../types/telegramWorker";

/** 读取当前线程已经安装的 Telegram 能力实现；未初始化时拒绝旁路联网。 */
export function currentTelegramApi(): TelegramApi {
  const current: TelegramApi | null = telegramApiState.current;
  if (current === null) {
    throw new Error("Telegram API capability has not been installed for this thread.");
  }
  return current;
}

/**
 * 由线程入口安装唯一能力实现。主线程安装真实客户端适配器，业务 Worker 安装
 * 双工代理；重复安装不同实现属于生命周期错误并立即拒绝。
 */
export function installTelegramApi(api: TelegramApi): void {
  const current: TelegramApi | null = telegramApiState.current;
  if (current !== null && current !== api) {
    throw new Error("Telegram API capability is already installed for this thread.");
  }
  telegramApiState.current = api;
}

/**
 * 稳定的线程内 Telegram 调用面。对象 shape 构造后不变；每次调用只读取当前
 * holder，主线程与 Worker 的业务动作因此共用同一套错误和结果归一化代码。
 */
export const telegramApi: TelegramApi = {
  answerCallbackQuery: (...args: Parameters<TelegramApi["answerCallbackQuery"]>): ReturnType<TelegramApi["answerCallbackQuery"]> =>
    currentTelegramApi().answerCallbackQuery(...args),
  banChatMember: (...args: Parameters<TelegramApi["banChatMember"]>): ReturnType<TelegramApi["banChatMember"]> =>
    currentTelegramApi().banChatMember(...args),
  banChatSenderChat: (...args: Parameters<TelegramApi["banChatSenderChat"]>): ReturnType<TelegramApi["banChatSenderChat"]> =>
    currentTelegramApi().banChatSenderChat(...args),
  copyMessage: (...args: Parameters<TelegramApi["copyMessage"]>): ReturnType<TelegramApi["copyMessage"]> =>
    currentTelegramApi().copyMessage(...args),
  deleteMessage: (...args: Parameters<TelegramApi["deleteMessage"]>): ReturnType<TelegramApi["deleteMessage"]> =>
    currentTelegramApi().deleteMessage(...args),
  deleteMessages: (...args: Parameters<TelegramApi["deleteMessages"]>): ReturnType<TelegramApi["deleteMessages"]> =>
    currentTelegramApi().deleteMessages(...args),
  deleteEphemeralMessage: (...args: Parameters<TelegramApi["deleteEphemeralMessage"]>): ReturnType<TelegramApi["deleteEphemeralMessage"]> =>
    currentTelegramApi().deleteEphemeralMessage(...args),
  getChat: (...args: Parameters<TelegramApi["getChat"]>): ReturnType<TelegramApi["getChat"]> =>
    currentTelegramApi().getChat(...args),
  getChatAdministrators: (...args: Parameters<TelegramApi["getChatAdministrators"]>): ReturnType<TelegramApi["getChatAdministrators"]> =>
    currentTelegramApi().getChatAdministrators(...args),
  editMessageText: (...args: Parameters<TelegramApi["editMessageText"]>): ReturnType<TelegramApi["editMessageText"]> =>
    currentTelegramApi().editMessageText(...args),
  getChatMember: (...args: Parameters<TelegramApi["getChatMember"]>): ReturnType<TelegramApi["getChatMember"]> =>
    currentTelegramApi().getChatMember(...args),
  getStickerSet: (...args: Parameters<TelegramApi["getStickerSet"]>): ReturnType<TelegramApi["getStickerSet"]> =>
    currentTelegramApi().getStickerSet(...args),
  restrictChatMember: (...args: Parameters<TelegramApi["restrictChatMember"]>): ReturnType<TelegramApi["restrictChatMember"]> =>
    currentTelegramApi().restrictChatMember(...args),
  sendAudio: (...args: Parameters<TelegramApi["sendAudio"]>): ReturnType<TelegramApi["sendAudio"]> =>
    currentTelegramApi().sendAudio(...args),
  sendChatAction: (...args: Parameters<TelegramApi["sendChatAction"]>): ReturnType<TelegramApi["sendChatAction"]> =>
    currentTelegramApi().sendChatAction(...args),
  sendMessage: (...args: Parameters<TelegramApi["sendMessage"]>): ReturnType<TelegramApi["sendMessage"]> =>
    currentTelegramApi().sendMessage(...args),
  sendPhoto: (...args: Parameters<TelegramApi["sendPhoto"]>): ReturnType<TelegramApi["sendPhoto"]> =>
    currentTelegramApi().sendPhoto(...args),
  sendSticker: (...args: Parameters<TelegramApi["sendSticker"]>): ReturnType<TelegramApi["sendSticker"]> =>
    currentTelegramApi().sendSticker(...args),
  setChatPermissions: (...args: Parameters<TelegramApi["setChatPermissions"]>): ReturnType<TelegramApi["setChatPermissions"]> =>
    currentTelegramApi().setChatPermissions(...args),
  setMessageReaction: (...args: Parameters<TelegramApi["setMessageReaction"]>): ReturnType<TelegramApi["setMessageReaction"]> =>
    currentTelegramApi().setMessageReaction(...args),
  unbanChatMember: (...args: Parameters<TelegramApi["unbanChatMember"]>): ReturnType<TelegramApi["unbanChatMember"]> =>
    currentTelegramApi().unbanChatMember(...args),
  unbanChatSenderChat: (...args: Parameters<TelegramApi["unbanChatSenderChat"]>): ReturnType<TelegramApi["unbanChatSenderChat"]> =>
    currentTelegramApi().unbanChatSenderChat(...args),
};

/** 统一展开 Telegram API 错误，保留 Bot API 的状态码和 description。 */
export function logApiError(action: string, error: unknown): void {
  const details: Readonly<{ errorCode: number; description: string }> | undefined =
    telegramErrorDetails(error);
  if (details !== undefined) {
    logger.error(`Failed to ${action}: ${details.errorCode} ${details.description}`);
  } else {
    logger.error(`Error trying to ${action}:`, error);
  }
}
