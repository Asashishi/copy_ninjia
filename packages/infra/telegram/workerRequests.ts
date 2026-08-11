import { InputFile } from "grammy";
import { bot } from "./mainClient";
import type { HydratedTelegramFile } from "./mainClient";
import type { SendTemporaryMessageOnMainParams } from "./temporaryMessage";
import { signalWithTimeout } from "../../libs/abortSignal";
import { readBoundedResponseBytes } from "../../libs/boundedResponse";
import {
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_FILE_METADATA_TIMEOUT_MS,
  MEDIA_MAX_DOWNLOAD_BYTES,
} from "../../consts/aiChat/media";
import { VOICE_MAX_DOWNLOAD_BYTES } from "../../consts/aiChat/voice";
import type { BoundedResponseResult } from "../../libs/boundedResponse";
import type {
  TelegramDeleteEphemeralMessagePayload,
  TelegramWorkerDownloadFileResult,
  TelegramWorkerJsonCall,
  TelegramWorkerRequest,
  TelegramWorkerTemporaryMessageResult,
} from "../../types/telegramWorker";
import {
  runTelegramCategorizedRequest,
  telegramRetryCategoryFor,
} from "./outboundGate";

async function sendTemporaryMessage(
  request: Extract<TelegramWorkerRequest, { operation: "sendTemporaryMessage" }>,
  signal: AbortSignal
): Promise<TelegramWorkerTemporaryMessageResult | undefined> {
  if (
    !Number.isSafeInteger(request.deleteAfterMs) ||
    request.deleteAfterMs <= 0
  ) {
    throw new Error("Telegram temporary message deletion delay must be a positive safe integer.");
  }
  // 组合能力会拉入线程内 Telegram 动作层；只在真正执行时加载，避免普通 Worker
  // 协议导入反向装载全部消息生命周期实现。
  const temporarySender: (
    params: SendTemporaryMessageOnMainParams
  ) => Promise<TelegramWorkerTemporaryMessageResult | undefined> =
    (await import("./temporaryMessage")).sendTemporaryMessageOnMain;
  return temporarySender({
    chatId: request.chatId,
    text: request.text,
    deleteAfterMs: request.deleteAfterMs,
    signal,
  });
}

function executeJsonCall(
  call: TelegramWorkerJsonCall,
  signal: AbortSignal
): Promise<unknown> {
  switch (call.method) {
    case "answerCallbackQuery":
      return bot.api.raw.answerCallbackQuery(call.payload, signal as never);
    case "banChatMember":
      return bot.api.raw.banChatMember(call.payload, signal as never);
    case "banChatSenderChat":
      return bot.api.raw.banChatSenderChat(call.payload, signal as never);
    case "copyMessage":
      return bot.api.raw.copyMessage(call.payload, signal as never);
    case "deleteMessage":
      return bot.api.raw.deleteMessage(call.payload, signal as never);
    case "deleteMessages":
      return bot.api.raw.deleteMessages(call.payload, signal as never);
    case "deleteEphemeralMessage":
      return (bot.api.raw as unknown as {
        deleteEphemeralMessage(
          payload: TelegramDeleteEphemeralMessagePayload,
          requestSignal: AbortSignal
        ): Promise<true>;
      }).deleteEphemeralMessage(call.payload, signal);
    case "getChat":
      return bot.api.raw.getChat(call.payload, signal as never);
    case "getChatAdministrators":
      return bot.api.raw.getChatAdministrators(call.payload, signal as never);
    case "getChatMember":
      return bot.api.raw.getChatMember(call.payload, signal as never);
    case "getStickerSet":
      return bot.api.raw.getStickerSet(call.payload, signal as never);
    case "restrictChatMember":
      return bot.api.raw.restrictChatMember(call.payload, signal as never);
    case "sendChatAction":
      return bot.api.raw.sendChatAction(call.payload, signal as never);
    case "sendMessage":
      return bot.api.raw.sendMessage(call.payload, signal as never);
    case "sendSticker":
      return bot.api.raw.sendSticker(call.payload, signal as never);
    case "setChatPermissions":
      return bot.api.raw.setChatPermissions(call.payload, signal as never);
    case "setMessageReaction":
      return bot.api.raw.setMessageReaction(call.payload, signal as never);
    case "unbanChatMember":
      return bot.api.raw.unbanChatMember(call.payload, signal as never);
    case "unbanChatSenderChat":
      return bot.api.raw.unbanChatSenderChat(call.payload, signal as never);
  }
}

async function downloadTelegramFile(
  request: Extract<TelegramWorkerRequest, { operation: "downloadFile" }>,
  signal: AbortSignal
): Promise<TelegramWorkerDownloadFileResult> {
  const maxBytes: number = request.purpose === "vision"
    ? MEDIA_MAX_DOWNLOAD_BYTES
    : VOICE_MAX_DOWNLOAD_BYTES;
  const file: HydratedTelegramFile = await bot.api.getFile(
    request.fileId,
    signalWithTimeout(signal, MEDIA_FILE_METADATA_TIMEOUT_MS) as never
  );
  if (!file.file_path) return { status: "missingPath" };
  const downloadSignal: AbortSignal = signalWithTimeout(
    signal,
    MEDIA_DOWNLOAD_TIMEOUT_MS
  );
  const response: Response = await runTelegramCategorizedRequest({
    category: "download",
    signal: downloadSignal,
    execute: (requestSignal: AbortSignal): Promise<Response> => fetch(file.getUrl(), {
      redirect: "error",
      signal: requestSignal,
    }),
  });
  if (!response.ok) {
    // 不读取错误页，但要显式释放响应体，避免持续失败时占住连接和缓冲。
    void response.body?.cancel().catch((): undefined => undefined);
    return { status: "httpError", httpStatus: response.status };
  }
  const download: BoundedResponseResult = await readBoundedResponseBytes(
    response,
    maxBytes
  );
  if (!download.ok) {
    return { status: "tooLarge", observedBytes: download.observedBytes };
  }
  if (download.bytes.byteLength === 0) return { status: "empty" };
  return { status: "ok", bytes: download.bytes };
}

/** 主线程执行已通过 Worker 能力白名单的 Telegram 请求。 */
async function executeTelegramWorkerRequest(
  request: TelegramWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  switch (request.operation) {
    case "call":
      if (telegramRetryCategoryFor(request.call.method) !== request.category) {
        throw new Error("Telegram Worker request category does not match its Bot API method.");
      }
      return executeJsonCall(request.call, signal);
    case "sendPhoto":
      if (request.category !== "message") {
        throw new Error("Telegram Worker sendPhoto must use the message category.");
      }
      return bot.api.sendPhoto(
        request.chatId,
        new InputFile(request.bytes, request.fileName),
        request.other,
        signal as never
      );
    case "sendAudio":
      if (request.category !== "message") {
        throw new Error("Telegram Worker sendAudio must use the message category.");
      }
      return bot.api.sendAudio(
        request.chatId,
        new InputFile(request.bytes, request.fileName),
        {
          ...request.other,
          ...(request.thumbnailBytes === undefined
            ? {}
            : { thumbnail: new InputFile(request.thumbnailBytes, "cover.jpg") }),
        },
        signal as never
      );
    case "downloadFile":
      if (request.category !== "download") {
        throw new Error("Telegram Worker downloadFile must use the download category.");
      }
      return downloadTelegramFile(request, signal);
    case "sendTemporaryMessage":
      if (request.category !== "message") {
        throw new Error("Telegram Worker temporary messages must use the message category.");
      }
      return sendTemporaryMessage(request, signal);
  }
}

function aiAllows(request: TelegramWorkerRequest): boolean {
  if (request.operation !== "call") {
    return request.operation === "downloadFile" ||
      request.operation === "sendPhoto" ||
      request.operation === "sendAudio";
  }
  switch (request.call.method) {
    case "getStickerSet":
    case "sendChatAction":
    case "sendMessage":
    case "sendSticker":
    case "setMessageReaction":
      return true;
    default:
      return false;
  }
}

function antiRaidAllows(request: TelegramWorkerRequest): boolean {
  if (request.operation === "sendTemporaryMessage") return true;
  if (request.operation !== "call") return false;
  switch (request.call.method) {
    case "answerCallbackQuery":
    case "banChatMember":
    case "banChatSenderChat":
    case "deleteMessage":
    case "deleteMessages":
    case "getChat":
    case "getChatAdministrators":
    case "getChatMember":
    case "restrictChatMember":
    case "sendMessage":
    case "setChatPermissions":
    case "unbanChatMember":
      return true;
    default:
      return false;
  }
}

/** AI Worker 只获得回复、媒体与贴纸所需的 Telegram 能力。 */
export function handleAiWorkerTelegramRequest(
  request: TelegramWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  if (!aiAllows(request)) {
    return Promise.reject(new Error("AI Worker requested an unsupported Telegram capability."));
  }
  return executeTelegramWorkerRequest(request, signal);
}

/** Anti-Raid Worker 只获得验证、限权、清理与成员查询能力。 */
export function handleAntiRaidWorkerTelegramRequest(
  request: TelegramWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  if (!antiRaidAllows(request)) {
    return Promise.reject(new Error("Anti-Raid Worker requested an unsupported Telegram capability."));
  }
  return executeTelegramWorkerRequest(request, signal);
}

/**
 * Telegram 下载成功回执把字节 buffer 直接转移给请求 Worker。主线程在能力处理器
 * 返回后不再读取该 Uint8Array，因此转移所有权不会留下失效引用。
 */
export function telegramWorkerResponseTransfer(
  request: TelegramWorkerRequest,
  value: unknown
): Bun.Transferable[] | undefined {
  if (
    request.operation !== "downloadFile" ||
    value === null ||
    typeof value !== "object" ||
    !("status" in value) ||
    value.status !== "ok" ||
    !("bytes" in value) ||
    !(value.bytes instanceof Uint8Array)
  ) return undefined;
  const buffer: ArrayBufferLike = value.bytes.buffer;
  return buffer instanceof ArrayBuffer ? [buffer] : undefined;
}
