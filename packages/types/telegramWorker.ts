import type { Api, RawApi } from "grammy";
import type { TelegramRetryCategory } from "./telegramOutbound";

/** 指定 grammY RawApi 方法的 JSON payload。 */
export type TelegramRawPayload<M extends keyof RawApi> = Parameters<RawApi[M]>[0];

/** Worker 允许通过主线程调用的 JSON Telegram Bot API 方法。 */
export type TelegramWorkerJsonCall =
  | { readonly method: "answerCallbackQuery"; readonly payload: TelegramRawPayload<"answerCallbackQuery"> }
  | { readonly method: "banChatMember"; readonly payload: TelegramRawPayload<"banChatMember"> }
  | { readonly method: "banChatSenderChat"; readonly payload: TelegramRawPayload<"banChatSenderChat"> }
  | { readonly method: "copyMessage"; readonly payload: TelegramRawPayload<"copyMessage"> }
  | { readonly method: "deleteMessage"; readonly payload: TelegramRawPayload<"deleteMessage"> }
  | { readonly method: "deleteMessages"; readonly payload: TelegramRawPayload<"deleteMessages"> }
  | { readonly method: "deleteEphemeralMessage"; readonly payload: TelegramRawPayload<"deleteEphemeralMessage"> }
  | { readonly method: "editMessageText"; readonly payload: TelegramRawPayload<"editMessageText"> }
  | { readonly method: "getChat"; readonly payload: TelegramRawPayload<"getChat"> }
  | { readonly method: "getChatAdministrators"; readonly payload: TelegramRawPayload<"getChatAdministrators"> }
  | { readonly method: "getChatMember"; readonly payload: TelegramRawPayload<"getChatMember"> }
  | { readonly method: "getStickerSet"; readonly payload: TelegramRawPayload<"getStickerSet"> }
  | { readonly method: "restrictChatMember"; readonly payload: TelegramRawPayload<"restrictChatMember"> }
  | { readonly method: "sendChatAction"; readonly payload: TelegramRawPayload<"sendChatAction"> }
  | { readonly method: "sendMessage"; readonly payload: TelegramRawPayload<"sendMessage"> }
  | { readonly method: "sendSticker"; readonly payload: TelegramRawPayload<"sendSticker"> }
  | { readonly method: "setChatPermissions"; readonly payload: TelegramRawPayload<"setChatPermissions"> }
  | { readonly method: "setMessageReaction"; readonly payload: TelegramRawPayload<"setMessageReaction"> }
  | { readonly method: "unbanChatMember"; readonly payload: TelegramRawPayload<"unbanChatMember"> }
  | { readonly method: "unbanChatSenderChat"; readonly payload: TelegramRawPayload<"unbanChatSenderChat"> };

/** Worker 上传图片所需的可克隆载荷；主线程重新构造 grammY InputFile。 */
export interface TelegramWorkerSendPhotoRequest {
  readonly operation: "sendPhoto";
  readonly category: "message";
  readonly chatId: number | string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly other: Omit<TelegramRawPayload<"sendPhoto">, "chat_id" | "photo">;
}

/** Worker 上传音频所需的可克隆载荷；缩略图缺省时显式为 undefined。 */
export interface TelegramWorkerSendAudioRequest {
  readonly operation: "sendAudio";
  readonly category: "message";
  readonly chatId: number | string;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly thumbnailBytes: Uint8Array | undefined;
  readonly other: Omit<TelegramRawPayload<"sendAudio">, "chat_id" | "audio" | "thumbnail">;
}

/** 主线程代 Worker 完成 getFile + Telegram 文件下载的两段式请求。 */
export interface TelegramWorkerDownloadFileRequest {
  readonly operation: "downloadFile";
  readonly category: "download";
  readonly fileId: string;
  readonly purpose: "vision" | "voice";
}

/**
 * Worker 请求主线程发送一条固定期限的群提示。发送成功与登记延迟删除由主线程
 * 同步完成，避免远端已经建消息、Worker 却在拿到 message_id 前退出而遗留提示。
 */
interface TelegramWorkerTemporaryMessageBase {
  readonly operation: "sendTemporaryMessage";
  readonly category: "message";
  readonly chatId: number;
  readonly messageThreadId?: number;
  readonly text: string;
  readonly deleteAfterMs: number;
}

/** 广告提示保留身份复查，其余群提示仅请求发送与清理。 */
export type TelegramWorkerTemporaryMessageRequest = TelegramWorkerTemporaryMessageBase & (
  | { readonly purpose: "adWarning"; readonly identityId: number }
  | { readonly purpose: "notice" }
);

/** 临时群提示已经发送且被主线程删除 owner 认领后的回执。 */
export interface TelegramWorkerTemporaryMessageSentResult {
  readonly messageId: number;
  /** 主线程收到 Telegram 成功响应的墙钟时刻。 */
  readonly sentAt: number;
}

/** 主线程发现目标当前拥有广告检测豁免，未向 Telegram 发出提示。 */
export interface TelegramWorkerTemporaryMessageSuppressedResult {
  readonly suppressed: true;
}

/** 引用广告警告请求的结算结果；undefined 仍表示实际发送失败。 */
export type TelegramWorkerTemporaryMessageResult =
  | TelegramWorkerTemporaryMessageSentResult
  | TelegramWorkerTemporaryMessageSuppressedResult;

export type TelegramWorkerDownloadFileResult =
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  | { readonly status: "missingPath" }
  | { readonly status: "httpError"; readonly httpStatus: number }
  | { readonly status: "tooLarge"; readonly observedBytes: number }
  | { readonly status: "empty" };

/**
 * Worker 与主线程共用的内存上传描述；不携带 grammY 运行时对象。
 * Worker 代理会把 bytes.buffer 直接转移给主线程，调用 sendPhoto/sendAudio 后
 * 原 Uint8Array 已失效，调用方不得读取或复用；这条所有权约束避免大媒体全量复制。
 */
export interface TelegramMemoryFile {
  readonly bytes: Uint8Array;
  readonly fileName: string;
}

/** 删除目标专属临时消息所需的稳定参数。 */
export interface TelegramDeleteEphemeralMessageParams {
  readonly chatId: number | string;
  readonly receiverUserId: number;
  readonly ephemeralMessageId: number;
}

/** 音频上传选项用项目内字节描述替代 grammY InputFile。 */
export type TelegramSendAudioOptions = Omit<
  NonNullable<Parameters<Api["sendAudio"]>[2]>,
  "thumbnail"
> & {
  readonly thumbnail?: TelegramMemoryFile;
};

/** Worker -> 主线程的 Telegram 能力请求。 */
export type TelegramWorkerRequest =
  | {
    readonly operation: "call";
    readonly category: TelegramRetryCategory;
    readonly call: TelegramWorkerJsonCall;
  }
  | TelegramWorkerSendPhotoRequest
  | TelegramWorkerSendAudioRequest
  | TelegramWorkerDownloadFileRequest
  | TelegramWorkerTemporaryMessageRequest;

/**
 * Telegram 动作层实际需要的 Api 子集。主线程由 bot.api 实现，业务 Worker 由
 * 双工代理实现；新增方法必须同时进入能力白名单与主线程分派。
 */
export type TelegramApi = Pick<Api,
  | "answerCallbackQuery"
  | "banChatMember"
  | "banChatSenderChat"
  | "copyMessage"
  | "deleteMessage"
  | "deleteMessages"
  | "editMessageText"
  | "getChat"
  | "getChatAdministrators"
  | "getChatMember"
  | "getStickerSet"
  | "restrictChatMember"
  | "sendChatAction"
  | "sendMessage"
  | "sendSticker"
  | "setChatPermissions"
  | "setMessageReaction"
  | "unbanChatMember"
  | "unbanChatSenderChat"
> & {
  deleteEphemeralMessage(
    params: TelegramDeleteEphemeralMessageParams,
    signal?: AbortSignal
  ): Promise<true>;
  sendAudio(
    chatId: Parameters<Api["sendAudio"]>[0],
    audio: TelegramMemoryFile,
    other?: TelegramSendAudioOptions,
    signal?: Parameters<Api["sendAudio"]>[3]
  ): ReturnType<Api["sendAudio"]>;
  sendPhoto(
    chatId: Parameters<Api["sendPhoto"]>[0],
    photo: TelegramMemoryFile,
    other?: Parameters<Api["sendPhoto"]>[2],
    signal?: Parameters<Api["sendPhoto"]>[3]
  ): ReturnType<Api["sendPhoto"]>;
};
