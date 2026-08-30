import type { Api } from "grammy";
import { requestMainThread } from "../../libs/workerDuplex";
import type {
  TelegramApi,
  TelegramDeleteEphemeralMessageParams,
  TelegramMemoryFile,
  TelegramRawPayload,
  TelegramWorkerDownloadFileResult,
  TelegramWorkerJsonCall,
  TelegramWorkerRequest,
  TelegramWorkerTemporaryMessageResult,
} from "../../types/telegramWorker";
import type { TelegramRetryCategory } from "../../types/telegramOutbound";

export interface DownloadTelegramFileFromMainParams {
  readonly fileId: string;
  readonly purpose: "vision" | "voice";
  readonly signal?: AbortSignal;
}

export interface SendTemporaryMessageFromMainParams {
  readonly chatId: number;
  readonly identityId: number;
  readonly text: string;
  readonly deleteAfterMs: number;
  readonly signal?: AbortSignal;
}

/**
 * 把「发群提示 + 登记固定延迟删除」作为一次主线程能力调用。返回成功时，提示
 * 已经进入主线程统一删除 owner，Worker 随后崩溃也不会丢失清理责任。
 */
export function sendTemporaryMessageFromMain({
  chatId,
  identityId,
  text,
  deleteAfterMs,
  signal,
}: SendTemporaryMessageFromMainParams): Promise<TelegramWorkerTemporaryMessageResult | undefined> {
  return requestMainThread<TelegramWorkerRequest, TelegramWorkerTemporaryMessageResult | undefined>({
    operation: "sendTemporaryMessage",
    category: "message",
    chatId,
    identityId,
    text,
    deleteAfterMs,
  }, signal);
}

/** Worker 的 Telegram 文件下载也经主线程执行，资源 URL 与网络响应不进入 isolate。 */
export function downloadTelegramFileFromMain({
  fileId,
  purpose,
  signal,
}: DownloadTelegramFileFromMainParams): Promise<TelegramWorkerDownloadFileResult> {
  return requestMainThread<TelegramWorkerRequest, TelegramWorkerDownloadFileResult>({
    operation: "downloadFile",
    category: "download",
    fileId,
    purpose,
  }, signal);
}

function requestCall<TResult>(
  category: TelegramRetryCategory,
  call: TelegramWorkerJsonCall,
  signal?: AbortSignal
): Promise<TResult> {
  const request: TelegramWorkerRequest = { operation: "call", category, call };
  return requestMainThread<TelegramWorkerRequest, TResult>(request, signal);
}

function asSignal(value: unknown): AbortSignal | undefined {
  return value as AbortSignal | undefined;
}

type TransferableTelegramMemoryFile = TelegramMemoryFile & {
  readonly bytes: Uint8Array<ArrayBuffer>;
};

/**
 * Worker 上传文件的完整普通 ArrayBuffer 直接移交，不再复制最多 24 MiB 的
 * 音频/图片。调用约定禁止发送后复用 bytes；SharedArrayBuffer 或子视图不能证明
 * 独占 backing store，只在这两个非标准输入上建立精确副本，避免 detach 其它别名。
 */
function checkedMemoryFile(value: unknown, label: string): TransferableTelegramMemoryFile {
  if (
    value === null ||
    typeof value !== "object" ||
    !("bytes" in value) ||
    !(value.bytes instanceof Uint8Array) ||
    !("fileName" in value) ||
    typeof value.fileName !== "string" ||
    value.fileName.length === 0
  ) {
    throw new TypeError(`${label} must use the project-owned in-memory file shape.`);
  }
  const bytes: Uint8Array = value.bytes;
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return value as TransferableTelegramMemoryFile;
  }
  return { bytes: new Uint8Array(bytes), fileName: value.fileName };
}

/**
 * 业务 Worker 的 grammY Api 结构化代理。它不创建或使用本地网络客户端；
 * 每个方法只把可克隆 payload 交给主线程双工能力边界。
 */
export const workerTelegramApi: TelegramApi = {
  answerCallbackQuery: (...args: Parameters<Api["answerCallbackQuery"]>): ReturnType<Api["answerCallbackQuery"]> => {
    const [callbackQueryId, other = {}, signal]: Parameters<Api["answerCallbackQuery"]> = args;
    return requestCall("callback", {
      method: "answerCallbackQuery",
      payload: { callback_query_id: callbackQueryId, ...other },
    }, asSignal(signal));
  },
  banChatMember: (...args: Parameters<Api["banChatMember"]>): ReturnType<Api["banChatMember"]> => {
    const [chatId, userId, other = {}, signal]: Parameters<Api["banChatMember"]> = args;
    return requestCall("kick", {
      method: "banChatMember",
      payload: { chat_id: chatId, user_id: userId, ...other },
    }, asSignal(signal));
  },
  banChatSenderChat: (...args: Parameters<Api["banChatSenderChat"]>): ReturnType<Api["banChatSenderChat"]> => {
    const [chatId, senderChatId, signal]: Parameters<Api["banChatSenderChat"]> = args;
    return requestCall("kick", {
      method: "banChatSenderChat",
      payload: { chat_id: chatId, sender_chat_id: senderChatId },
    }, asSignal(signal));
  },
  copyMessage: (...args: Parameters<Api["copyMessage"]>): ReturnType<Api["copyMessage"]> => {
    const [chatId, fromChatId, messageId, other = {}, signal]: Parameters<Api["copyMessage"]> = args;
    return requestCall("message", {
      method: "copyMessage",
      payload: { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...other },
    }, asSignal(signal));
  },
  deleteMessage: (...args: Parameters<Api["deleteMessage"]>): ReturnType<Api["deleteMessage"]> => {
    const [chatId, messageId, signal]: Parameters<Api["deleteMessage"]> = args;
    return requestCall("delete", {
      method: "deleteMessage",
      payload: { chat_id: chatId, message_id: messageId },
    }, asSignal(signal));
  },
  deleteMessages: (...args: Parameters<Api["deleteMessages"]>): ReturnType<Api["deleteMessages"]> => {
    const [chatId, messageIds, signal]: Parameters<Api["deleteMessages"]> = args;
    return requestCall("delete", {
      method: "deleteMessages",
      payload: { chat_id: chatId, message_ids: messageIds },
    }, asSignal(signal));
  },
  deleteEphemeralMessage: ({
    chatId,
    receiverUserId,
    ephemeralMessageId,
  }: TelegramDeleteEphemeralMessageParams, signal?: AbortSignal): Promise<true> =>
    requestCall("delete", {
      method: "deleteEphemeralMessage",
      payload: {
        chat_id: chatId,
        receiver_user_id: receiverUserId,
        ephemeral_message_id: ephemeralMessageId,
      },
    }, signal),
  getChat: (...args: Parameters<Api["getChat"]>): ReturnType<Api["getChat"]> => {
    const [chatId, signal]: Parameters<Api["getChat"]> = args;
    return requestCall("query", { method: "getChat", payload: { chat_id: chatId } }, asSignal(signal));
  },
  getChatAdministrators: (...args: Parameters<Api["getChatAdministrators"]>): ReturnType<Api["getChatAdministrators"]> => {
    const [chatId, signal]: Parameters<Api["getChatAdministrators"]> = args;
    return requestCall("query", {
      method: "getChatAdministrators",
      payload: { chat_id: chatId },
    }, asSignal(signal));
  },
  getChatMember: (...args: Parameters<Api["getChatMember"]>): ReturnType<Api["getChatMember"]> => {
    const [chatId, userId, signal]: Parameters<Api["getChatMember"]> = args;
    return requestCall("query", {
      method: "getChatMember",
      payload: { chat_id: chatId, user_id: userId },
    }, asSignal(signal));
  },
  getStickerSet: (...args: Parameters<Api["getStickerSet"]>): ReturnType<Api["getStickerSet"]> => {
    const [name, signal]: Parameters<Api["getStickerSet"]> = args;
    return requestCall("query", { method: "getStickerSet", payload: { name } }, asSignal(signal));
  },
  restrictChatMember: (...args: Parameters<Api["restrictChatMember"]>): ReturnType<Api["restrictChatMember"]> => {
    const [chatId, userId, permissions, other = {}, signal]: Parameters<Api["restrictChatMember"]> = args;
    return requestCall("restrict", {
      method: "restrictChatMember",
      payload: { chat_id: chatId, user_id: userId, permissions, ...other },
    }, asSignal(signal));
  },
  sendAudio: (...args: Parameters<TelegramApi["sendAudio"]>): ReturnType<TelegramApi["sendAudio"]> => {
    const [chatId, audioValue, other = {}, signal]: Parameters<TelegramApi["sendAudio"]> = args;
    return (async (): ReturnType<TelegramApi["sendAudio"]> => {
      const audio: TransferableTelegramMemoryFile = checkedMemoryFile(audioValue, "Worker audio");
      const audioBytes: Uint8Array<ArrayBuffer> = audio.bytes;
      const thumbnailValue: TelegramMemoryFile | undefined = other.thumbnail;
      let thumbnailBytes: Uint8Array<ArrayBuffer> | undefined;
      if (thumbnailValue !== undefined) {
        const thumbnail: TransferableTelegramMemoryFile = checkedMemoryFile(
          thumbnailValue,
          "Worker audio thumbnail"
        );
        thumbnailBytes = thumbnail.bytes;
      }
      const payloadOther: Omit<TelegramRawPayload<"sendAudio">, "chat_id" | "audio" | "thumbnail"> = {
        ...other,
      };
      delete (payloadOther as Partial<TelegramRawPayload<"sendAudio">>).thumbnail;
      const transfer: Bun.Transferable[] = [audioBytes.buffer];
      if (thumbnailBytes !== undefined && thumbnailBytes.buffer !== audioBytes.buffer) {
        transfer.push(thumbnailBytes.buffer);
      }
      return requestMainThread<TelegramWorkerRequest, Awaited<ReturnType<Api["sendAudio"]>>>({
        operation: "sendAudio",
        category: "message",
        chatId,
        bytes: audioBytes,
        fileName: audio.fileName,
        thumbnailBytes,
        other: payloadOther,
      }, asSignal(signal), transfer);
    })();
  },
  sendChatAction: (...args: Parameters<Api["sendChatAction"]>): ReturnType<Api["sendChatAction"]> => {
    const [chatId, action, other = {}, signal]: Parameters<Api["sendChatAction"]> = args;
    return requestCall("chatAction", {
      method: "sendChatAction",
      payload: { chat_id: chatId, action, ...other },
    }, asSignal(signal));
  },
  sendMessage: (...args: Parameters<Api["sendMessage"]>): ReturnType<Api["sendMessage"]> => {
    const [chatId, text, other = {}, signal]: Parameters<Api["sendMessage"]> = args;
    return requestCall("message", {
      method: "sendMessage",
      payload: { chat_id: chatId, text, ...other },
    }, asSignal(signal));
  },
  sendPhoto: (...args: Parameters<TelegramApi["sendPhoto"]>): ReturnType<TelegramApi["sendPhoto"]> => {
    const [chatId, photoValue, other = {}, signal]: Parameters<TelegramApi["sendPhoto"]> = args;
    return (async (): ReturnType<TelegramApi["sendPhoto"]> => {
      const photo: TransferableTelegramMemoryFile = checkedMemoryFile(photoValue, "Worker photo");
      const bytes: Uint8Array<ArrayBuffer> = photo.bytes;
      return requestMainThread<TelegramWorkerRequest, Awaited<ReturnType<Api["sendPhoto"]>>>({
        operation: "sendPhoto",
        category: "message",
        chatId,
        bytes,
        fileName: photo.fileName,
        other,
      }, asSignal(signal), [bytes.buffer]);
    })();
  },
  editMessageText: (...args: Parameters<TelegramApi["editMessageText"]>): ReturnType<TelegramApi["editMessageText"]> => {
    const [chatId, messageId, text, other = {}, signal]: Parameters<TelegramApi["editMessageText"]> = args;
    if (typeof text !== "string") {
      return Promise.reject(new TypeError("Worker editMessageText requires plain text."));
    }
    return requestCall("edit", {
      method: "editMessageText",
      payload: { chat_id: chatId, message_id: messageId, text, ...other },
    }, asSignal(signal));
  },
  sendSticker: (...args: Parameters<Api["sendSticker"]>): ReturnType<Api["sendSticker"]> => {
    const [chatId, sticker, other = {}, signal]: Parameters<Api["sendSticker"]> = args;
    if (typeof sticker !== "string") {
      return Promise.reject(new TypeError("Worker sendSticker requires a Telegram file_id."));
    }
    return requestCall("message", {
      method: "sendSticker",
      payload: { chat_id: chatId, sticker, ...other },
    }, asSignal(signal));
  },
  setChatPermissions: (...args: Parameters<Api["setChatPermissions"]>): ReturnType<Api["setChatPermissions"]> => {
    const [chatId, permissions, other = {}, signal]: Parameters<Api["setChatPermissions"]> = args;
    return requestCall("restrict", {
      method: "setChatPermissions",
      payload: { chat_id: chatId, permissions, ...other },
    }, asSignal(signal));
  },
  setMessageReaction: (...args: Parameters<Api["setMessageReaction"]>): ReturnType<Api["setMessageReaction"]> => {
    const [chatId, messageId, reaction, other = {}, signal]: Parameters<Api["setMessageReaction"]> = args;
    return requestCall("reaction", {
      method: "setMessageReaction",
      payload: { chat_id: chatId, message_id: messageId, reaction, ...other },
    }, asSignal(signal));
  },
  unbanChatMember: (...args: Parameters<Api["unbanChatMember"]>): ReturnType<Api["unbanChatMember"]> => {
    const [chatId, userId, other = {}, signal]: Parameters<Api["unbanChatMember"]> = args;
    return requestCall("kick", {
      method: "unbanChatMember",
      payload: { chat_id: chatId, user_id: userId, ...other },
    }, asSignal(signal));
  },
  unbanChatSenderChat: (...args: Parameters<Api["unbanChatSenderChat"]>): ReturnType<Api["unbanChatSenderChat"]> => {
    const [chatId, senderChatId, signal]: Parameters<Api["unbanChatSenderChat"]> = args;
    return requestCall("kick", {
      method: "unbanChatSenderChat",
      payload: { chat_id: chatId, sender_chat_id: senderChatId },
    }, asSignal(signal));
  },
};
