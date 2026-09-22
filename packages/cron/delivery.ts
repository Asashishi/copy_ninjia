/**
 * cron 动作的唯一 Telegram 发送边界（`check:conventions` 禁止 packages/cron/ 其它文件发送）。
 *
 * cron 消息是用户授权的长期保留例外（见 AGENTS.md「Telegram 提示留存」），不挂固定
 * 延迟删除；不带话题（落在 General），不设 `parse_mode`。全部请求都经主线程
 * grammY 客户端，因此照常经过发送类 throttler 与 429 分类出站闸；成功后登记自发消息。
 * 单图调用 sendPhoto，多图调用一次 sendMediaGroup，只有首图携带 caption；
 * 相册逐项应用遮罩并登记所有返回消息 ID。每次调用只投递一次，
 * 失败按 CronDeliveryOutcome 分类交给 cron/run.ts 决定是否重试，
 * 本边界不记日志。
 */

import { HttpError, InputFile } from "grammy";
import type { InputMediaPhoto, Message } from "grammy/types";
import type { Stats } from "node:fs";
import { basename } from "node:path";
import { TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES, TELEGRAM_PHOTO_UPLOAD_MAX_BYTES } from "../consts/telegram";
import { pickRandomImage } from "../infra/randomImage";
import { getRandomHImageDirectory } from "../infra/storage/stateStore";
import { runTelegramAction } from "../infra/telegram/actions/core";
import { toTelegramSendResult } from "../infra/telegram/actions/sendResult";
import { telegramErrorDetails } from "../infra/telegram/errors";
import { bot } from "../infra/telegram/mainClient";
import { TelegramRetryQueueFullError } from "../infra/telegram/outboundRetryPolicy";
import { signalArgs } from "../libs/telegramSignalArgs";
import type { CronAction, CronDeliveryOutcome, CronFileSource, CronImageSource } from "../types/cron";
import type { RandomImagePick } from "../types/randomImage";
import { errorMessage } from "../libs/errorMessage";

/** 一次发送失败的分类：服务端 5xx、仍被 429 挡住、出站队列满与网络错误可重试，其余 4xx 与本地错误不重试。 */
function classifyFailure(error: unknown): CronDeliveryOutcome {
  if (error instanceof TelegramRetryQueueFullError) {
    return { kind: "retryable", detail: "the Telegram outbound retry queue is full" };
  }
  const details: Readonly<{ errorCode: number; description: string }> | undefined = telegramErrorDetails(error);
  if (details !== undefined) {
    const detail: string = `${details.errorCode} ${details.description}`;
    return details.errorCode >= 500 || details.errorCode === 429
      ? { kind: "retryable", detail }
      : { kind: "permanent", detail };
  }
  const message: string = errorMessage(error);
  return error instanceof HttpError ? { kind: "retryable", detail: message } : { kind: "permanent", detail: message };
}

/** 执行一次发送；成功登记自发消息，失败取回错误分类而不记日志。 */
async function send(
  chatId: number,
  execute: (signal?: AbortSignal) => Promise<Message | Message[]>,
  signal: AbortSignal
): Promise<CronDeliveryOutcome> {
  let failure: unknown;
  const sent: true | undefined = await runTelegramAction({
    action: "send a cron message",
    execute,
    map: (messages: Message | Message[]): true => {
      if (Array.isArray(messages)) {
        for (const message of messages) toTelegramSendResult(chatId, message);
      } else toTelegramSendResult(chatId, messages);
      return true;
    },
    fallback: undefined,
    signal,
    shouldLogError: (error: unknown): boolean => {
      failure = error;
      return false;
    },
  });
  if (sent !== undefined) return { kind: "sent" };
  if (signal.aborted) return { kind: "aborted" };
  return classifyFailure(failure);
}

/**
 * 本地文件的上传源：先确认仍是不超过上限的普通文件；每次序列化都重新打开一条流，
 * 429 重放或重试不会拿到已读完的流。
 */
async function localUpload(path: string, maxBytes: number): Promise<InputFile | CronDeliveryOutcome> {
  let size: number;
  try {
    const stats: Stats = await Bun.file(path).stat();
    if (!stats.isFile()) return { kind: "permanent", detail: `local file ${basename(path)} is no longer a regular file` };
    size = stats.size;
  } catch {
    return { kind: "permanent", detail: `local file ${basename(path)} is missing` };
  }
  if (size > maxBytes) {
    return { kind: "permanent", detail: `local file ${basename(path)} exceeds the Telegram upload limit of ${maxBytes} bytes` };
  }
  return new InputFile((): ReadableStream<Uint8Array> => Bun.file(path).stream(), basename(path));
}

/** 异步抽取单张图片并归一化图库错误，缺省目录使用专用图库。 */
async function randomImageInput(directory: string | null): Promise<InputFile | CronDeliveryOutcome> {
  const pick: RandomImagePick = await pickRandomImage(directory ?? getRandomHImageDirectory());
  switch (pick.status) {
    case "ok":
      return new InputFile(pick.bytes, pick.fileName);
    case "missingDirectory":
      return { kind: "permanent", detail: "the random image directory is missing" };
    case "empty":
      return { kind: "permanent", detail: "the random image directory has no pictures" };
    case "tooLarge":
      return {
        kind: "permanent",
        detail: `the random image directory has no picture under the Telegram upload limit (last oversized: ${pick.fileName})`,
      };
  }
}

/** 整组预检后才提交请求；本地来源逐个异步 stat，只保留可重开的流 supplier。 */
async function imageInputs(
  source: CronImageSource,
  signal: AbortSignal
): Promise<(string | InputFile)[] | CronDeliveryOutcome> {
  if (signal.aborted) return { kind: "aborted" };
  if (source.kind === "urls") return [...source.urls];
  if (source.kind === "random") {
    const photo: InputFile | CronDeliveryOutcome = await randomImageInput(source.directory);
    return isOutcome(photo) ? photo : [photo];
  }
  const photos: (string | InputFile)[] = [];
  for (const path of source.paths) {
    if (signal.aborted) return { kind: "aborted" };
    const photo: InputFile | CronDeliveryOutcome = await localUpload(path, TELEGRAM_PHOTO_UPLOAD_MAX_BYTES);
    if (isOutcome(photo)) return photo;
    photos.push(photo);
  }
  return photos;
}

/** 解析文件来源：地址原样交给 Telegram，本地文件转成上传源。 */
async function fileInput(source: CronFileSource): Promise<string | InputFile | CronDeliveryOutcome> {
  return source.kind === "url" ? source.url : localUpload(source.path, TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES);
}

/** 解析出的上传源是否其实是一个失败结果。 */
function isOutcome(value: string | InputFile | CronDeliveryOutcome): value is CronDeliveryOutcome {
  return typeof value === "object" && !(value instanceof InputFile);
}

/**
 * 向一个会话投递一个动作一次。`rand_image` 每次调用都重新抽取；抽不出或本地文件不可用
 * 按不可重试失败返回。signal 取消在途请求（停机超时）。
 */
export async function deliverCronAction(
  chatId: number,
  action: Readonly<CronAction>,
  signal: AbortSignal
): Promise<CronDeliveryOutcome> {
  if (signal.aborted) return { kind: "aborted" };
  switch (action.type) {
    case "send_message":
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendMessage(
        chatId,
        action.content,
        undefined,
        ...signalArgs(requestSignal)
      ), signal);
    case "send_image": {
      const photos: (string | InputFile)[] | CronDeliveryOutcome = await imageInputs(action.source, signal);
      if (signal.aborted) return { kind: "aborted" };
      if (!Array.isArray(photos)) return photos;
      if (photos.length > 1) {
        const media: InputMediaPhoto[] = [];
        for (let index: number = 0; index < photos.length; index++) {
          media.push({
            type: "photo",
            media: photos[index]!,
            caption: index === 0 ? action.content : undefined,
            has_spoiler: action.isBlurred ? true : undefined,
          });
        }
        return send(chatId, (requestSignal?: AbortSignal): Promise<Message[]> => bot.api.sendMediaGroup(
          chatId, media, undefined, ...signalArgs(requestSignal)
        ), signal);
      }
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendPhoto(
        chatId,
        photos[0]!,
        { caption: action.content, has_spoiler: action.isBlurred ? true : undefined },
        ...signalArgs(requestSignal)
      ), signal);
    }
    case "send_file": {
      const document: string | InputFile | CronDeliveryOutcome = await fileInput(action.source);
      if (signal.aborted) return { kind: "aborted" };
      if (isOutcome(document)) return document;
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendDocument(
        chatId,
        document,
        { caption: action.content },
        ...signalArgs(requestSignal)
      ), signal);
    }
  }
}
