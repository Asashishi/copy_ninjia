/**
 * 主线程 Telegram 网络客户端边界。业务 Worker 不得 import 本文件；它们只加载
 * workerClient.ts 的结构化双工代理。
 */

import { hydrateFiles } from "@grammyjs/files";
import type { FileApiFlavor } from "@grammyjs/files";
import { Bot, InputFile } from "grammy";
import type { Api, Context } from "grammy";
import { telegramClientInitialization } from "../../cache/main/telegram";
import { BOT_TOKEN } from "../../config/telegram";
import { installTelegramApi } from "./client";
import { telegramMessageThrottler } from "./messageThrottler";
import {
  telegramOutboundGate,
} from "./outboundGate";
import { initTelegramOutbound } from "./outboundLifecycle";
import type {
  TelegramApi,
  TelegramDeleteEphemeralMessageParams,
  TelegramMemoryFile,
  TelegramSendAudioOptions,
} from "../../types/telegramWorker";

type FirstOverloadReturn<T> = T extends {
  (...args: never[]): infer FirstReturn;
  (...args: never[]): unknown;
} ? FirstReturn : never;

/** 官方 files API flavor 中增强后的 getFile 返回值。 */
export type HydratedTelegramFile = Awaited<FirstOverloadReturn<FileApiFlavor<Api>["getFile"]>>;

/** 主线程唯一的真实 grammY Bot；所有 Bot API HTTP 最终都由它发起。 */
export const bot: Bot<Context, FileApiFlavor<Api>> =
  new Bot<Context, FileApiFlavor<Api>>(BOT_TOKEN);

/**
 * 主线程项目能力面。JSON 方法原样转交 grammY；内存文件在这里才转换成
 * InputFile，Worker 协议与共享动作层都不加载 grammY 运行时对象。
 */
const mainTelegramApi: TelegramApi = {
  answerCallbackQuery: (...args: Parameters<TelegramApi["answerCallbackQuery"]>): ReturnType<TelegramApi["answerCallbackQuery"]> =>
    bot.api.answerCallbackQuery(...args),
  banChatMember: (...args: Parameters<TelegramApi["banChatMember"]>): ReturnType<TelegramApi["banChatMember"]> =>
    bot.api.banChatMember(...args),
  banChatSenderChat: (...args: Parameters<TelegramApi["banChatSenderChat"]>): ReturnType<TelegramApi["banChatSenderChat"]> =>
    bot.api.banChatSenderChat(...args),
  copyMessage: (...args: Parameters<TelegramApi["copyMessage"]>): ReturnType<TelegramApi["copyMessage"]> =>
    bot.api.copyMessage(...args),
  editMessageText: (...args: Parameters<TelegramApi["editMessageText"]>): ReturnType<TelegramApi["editMessageText"]> =>
    bot.api.editMessageText(...args),
  deleteMessage: (...args: Parameters<TelegramApi["deleteMessage"]>): ReturnType<TelegramApi["deleteMessage"]> =>
    bot.api.deleteMessage(...args),
  deleteMessages: (...args: Parameters<TelegramApi["deleteMessages"]>): ReturnType<TelegramApi["deleteMessages"]> =>
    bot.api.deleteMessages(...args),
  deleteEphemeralMessage: ({
    chatId,
    receiverUserId,
    ephemeralMessageId,
  }: TelegramDeleteEphemeralMessageParams, signal?: AbortSignal): Promise<true> =>
    bot.api.raw.deleteEphemeralMessage({
      chat_id: chatId,
      receiver_user_id: receiverUserId,
      ephemeral_message_id: ephemeralMessageId,
    }, signal as never),
  getChat: (...args: Parameters<TelegramApi["getChat"]>): ReturnType<TelegramApi["getChat"]> =>
    bot.api.getChat(...args),
  getChatAdministrators: (...args: Parameters<TelegramApi["getChatAdministrators"]>): ReturnType<TelegramApi["getChatAdministrators"]> =>
    bot.api.getChatAdministrators(...args),
  getChatMember: (...args: Parameters<TelegramApi["getChatMember"]>): ReturnType<TelegramApi["getChatMember"]> =>
    bot.api.getChatMember(...args),
  getStickerSet: (...args: Parameters<TelegramApi["getStickerSet"]>): ReturnType<TelegramApi["getStickerSet"]> =>
    bot.api.getStickerSet(...args),
  restrictChatMember: (...args: Parameters<TelegramApi["restrictChatMember"]>): ReturnType<TelegramApi["restrictChatMember"]> =>
    bot.api.restrictChatMember(...args),
  // grammY 的外部签名固定为四个位置参数；此处适配层必须逐位透传。
  // eslint-disable-next-line max-params
  sendAudio: (
    chatId: Parameters<TelegramApi["sendAudio"]>[0],
    audio: TelegramMemoryFile,
    other: TelegramSendAudioOptions = {},
    signal?: Parameters<TelegramApi["sendAudio"]>[3]
  ): ReturnType<TelegramApi["sendAudio"]> => {
    const {
      thumbnail,
      ...grammyFields
    }: TelegramSendAudioOptions = other;
    const grammyOther: Parameters<Api["sendAudio"]>[2] = {
      ...grammyFields,
      ...(thumbnail === undefined
        ? {}
        : { thumbnail: new InputFile(thumbnail.bytes, thumbnail.fileName) }),
    };
    return bot.api.sendAudio(
      chatId,
      new InputFile(audio.bytes, audio.fileName),
      grammyOther,
      signal
    );
  },
  sendChatAction: (...args: Parameters<TelegramApi["sendChatAction"]>): ReturnType<TelegramApi["sendChatAction"]> =>
    bot.api.sendChatAction(...args),
  sendMessage: (...args: Parameters<TelegramApi["sendMessage"]>): ReturnType<TelegramApi["sendMessage"]> =>
    bot.api.sendMessage(...args),
  // grammY 的外部签名固定为四个位置参数；此处适配层必须逐位透传。
  // eslint-disable-next-line max-params
  sendPhoto: (
    chatId: Parameters<TelegramApi["sendPhoto"]>[0],
    photo: TelegramMemoryFile,
    other: Parameters<TelegramApi["sendPhoto"]>[2] = {},
    signal?: Parameters<TelegramApi["sendPhoto"]>[3]
  ): ReturnType<TelegramApi["sendPhoto"]> => bot.api.sendPhoto(
    chatId,
    new InputFile(photo.bytes, photo.fileName),
    other,
    signal
  ),
  sendSticker: (...args: Parameters<TelegramApi["sendSticker"]>): ReturnType<TelegramApi["sendSticker"]> =>
    bot.api.sendSticker(...args),
  setChatPermissions: (...args: Parameters<TelegramApi["setChatPermissions"]>): ReturnType<TelegramApi["setChatPermissions"]> =>
    bot.api.setChatPermissions(...args),
  setMessageReaction: (...args: Parameters<TelegramApi["setMessageReaction"]>): ReturnType<TelegramApi["setMessageReaction"]> =>
    bot.api.setMessageReaction(...args),
  unbanChatMember: (...args: Parameters<TelegramApi["unbanChatMember"]>): ReturnType<TelegramApi["unbanChatMember"]> =>
    bot.api.unbanChatMember(...args),
  unbanChatSenderChat: (...args: Parameters<TelegramApi["unbanChatSenderChat"]>): ReturnType<TelegramApi["unbanChatSenderChat"]> =>
    bot.api.unbanChatSenderChat(...args),
};

/**
 * 集中安装文件增强、发送类节流与分类型 429 退避。主进程须在取得 bot.lock
 * 后调用；模块导入本身不创建计时器或网络请求，重复调用幂等。
 */
export function initTelegramClients(): void {
  if (!Bun.isMainThread) {
    throw new Error("Telegram network clients can only be initialized by the main thread.");
  }
  if (telegramClientInitialization.current) return;
  initTelegramOutbound();
  bot.api.config.use(hydrateFiles(bot.token));
  bot.api.config.use(telegramMessageThrottler());
  bot.api.config.use(telegramOutboundGate());
  installTelegramApi(mainTelegramApi);
  telegramClientInitialization.current = true;
}
