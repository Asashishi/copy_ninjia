import { InputFile } from "grammy";
import { COMMAND_MESSAGE_AUTO_DELETE_MS } from "../../consts/commands";
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
  TelegramWorkerDownloadFileResult,
  TelegramWorkerJsonCall,
  TelegramWorkerRequest,
  TelegramWorkerTemporaryMessageResult,
  TelegramWorkerTemporaryMessageSentResult,
} from "../../types/telegramWorker";
import { runTelegramCategorizedRequest } from "./outboundGate";
import { telegramRetryCategoryFor } from "./outboundRetryPolicy";
import { markSelfSent } from "../selfSentTracker";

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
  if (request.purpose === "notice" && request.deleteAfterMs !== COMMAND_MESSAGE_AUTO_DELETE_MS) {
    throw new Error("Telegram group notices must use the standard deletion delay.");
  }
  // 组合能力会拉入线程内 Telegram 动作层；只在真正执行时加载，避免普通 Worker
  // 协议导入反向装载全部消息生命周期实现。
  const temporarySender: (
    params: SendTemporaryMessageOnMainParams
  ) => Promise<TelegramWorkerTemporaryMessageSentResult | undefined> =
    (await import("./temporaryMessage")).sendTemporaryMessageOnMain;
  return temporarySender({
    chatId: request.chatId,
    text: request.text,
    deleteAfterMs: request.deleteAfterMs,
    messageThreadId: request.messageThreadId,
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
      return bot.api.raw.deleteEphemeralMessage(call.payload, signal as never);
    case "editMessageText":
      return bot.api.raw.editMessageText(call.payload, signal as never);
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

/**
 * 把 Worker 经本边界发出的消息登记进**主线程**的自发消息表。
 *
 * 存在的理由是 `infra/selfSentTracker.ts` 按线程隔离：Worker 侧那次
 * `sendMessage` 在自己的 isolate 里 `markSelfSent`，而真正的 Bot API 调用发生在
 * 下面的 `bot.api.raw.*`——那条路绕开了共享动作层的登记。主线程因此认不出这条
 * 消息是自己发的，频道帖回投时会被当成新内容喂进 AI/复读流水线，或被
 * `/set_qa` 的投递入口认领（三个入口的判定见 auto/message/index.ts、
 * commands/cjkAction.ts、commands/qa/ingress.ts）。
 *
 * 登记发生在**响应回传给 Worker 之前**，也就是早于 Worker 拿到 message id 的那一
 * 刻。两个 Worker 都不回投「我发了什么」，本函数因此是全部 Worker 自发消息的
 * **唯一**登记点。
 *
 * **但这不消除回投竞态，只把它收窄**：登记时刻是发送响应落地，而回投可能由一次
 * 并发的长轮询先取回。入口侧因此仍要在同步的 `isBotOwnMessage` 之外走有界
 * rendezvous，见 docs/cn/04-invariants.md 的「出站请求与消息安全」。
 *
 * 判据取**返回值的形状**而不是按方法名 switch：新增能力只要产出 Message 就自动
 * 被覆盖，不必记得回来改这里。读结果而不读 payload 的 `chat_id`，是因为后者可以
 * 是 `@username` 字符串，而结果里的 `chat.id` 恒为数字（唯一只返回
 * `MessageId`、拿不到 chat 的 `copyMessage` 不在任何 Worker 能力白名单里）。
 */
function markWorkerSentMessage(result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  if (!("message_id" in result) || !("chat" in result)) return;
  const messageId: unknown = result.message_id;
  const chat: unknown = result.chat;
  if (typeof messageId !== "number") return;
  if (typeof chat !== "object" || chat === null || !("id" in chat)) return;
  const chatId: unknown = chat.id;
  if (typeof chatId !== "number") return;
  markSelfSent(chatId, messageId);
}

/** 按操作分派到具体的主线程实现；能力白名单已在调用方判过。 */
async function dispatchTelegramWorkerRequest(
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

/**
 * 主线程执行已通过 Worker 能力白名单的 Telegram 请求。
 *
 * 所有 Worker 的 Telegram 请求都收在这一个漏斗里，自发消息登记因此也只此一处
 * （见 markWorkerSentMessage）。
 */
async function executeTelegramWorkerRequest(
  request: TelegramWorkerRequest,
  signal: AbortSignal
): Promise<unknown> {
  const result: unknown = await dispatchTelegramWorkerRequest(request, signal);
  markWorkerSentMessage(result);
  return result;
}

function aiAllows(request: TelegramWorkerRequest): boolean {
  if (request.operation !== "call") {
    return (request.operation === "sendTemporaryMessage" && request.purpose === "notice") ||
      request.operation === "downloadFile" ||
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
