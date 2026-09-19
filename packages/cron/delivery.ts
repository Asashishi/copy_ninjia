/**
 * cron 动作的唯一 Telegram 发送边界（`check:conventions` 禁止 packages/cron/ 其它文件发送）。
 *
 * cron 消息是用户授权的长期保留例外（见 AGENTS.md「Telegram 提示留存」），不挂固定
 * 延迟删除；按任务配置带 `message_thread_id`，不设 `parse_mode`。全部请求都经主线程
 * grammY 客户端，因此照常经过发送类 throttler 与 429 分类出站闸；成功后登记自发消息。
 * 每次调用只投递一次，失败按 CronDeliveryOutcome 分类交给 cron/run.ts 决定是否重试，
 * 本边界不记日志。
 */

import { HttpError, InputFile } from "grammy";
import type { Message } from "grammy/types";
import type { Stats } from "node:fs";
import { basename } from "node:path";
import { TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES, TELEGRAM_PHOTO_UPLOAD_MAX_BYTES } from "../consts/telegram";
import { pickRandomImage } from "../infra/randomImage";
import { getRandomImageDirectory } from "../infra/storage/stateStore";
import { runTelegramAction } from "../infra/telegram/actions/core";
import { toTelegramSendResult } from "../infra/telegram/actions/sendResult";
import { telegramErrorDetails } from "../infra/telegram/errors";
import { bot } from "../infra/telegram/mainClient";
import { TelegramRetryQueueFullError } from "../infra/telegram/outboundRetryPolicy";
import { signalArgs } from "../libs/telegramSignalArgs";
import type { CronAction, CronDeliveryOutcome, CronFileSource, CronImageSource, CronTask } from "../types/cron";
import type { RandomImagePick } from "../types/randomImage";
import type { TelegramSendResult } from "../types/telegram";

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
  const message: string = error instanceof Error ? error.message : String(error);
  return error instanceof HttpError ? { kind: "retryable", detail: message } : { kind: "permanent", detail: message };
}

/** 执行一次发送；成功登记自发消息，失败取回错误分类而不记日志。 */
async function send(
  chatId: number,
  execute: (signal?: AbortSignal) => Promise<Message>,
  signal: AbortSignal
): Promise<CronDeliveryOutcome> {
  let failure: unknown;
  const sent: TelegramSendResult | undefined = await runTelegramAction({
    action: "send a cron message",
    execute,
    map: (message: Message): TelegramSendResult => toTelegramSendResult(chatId, message),
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

/** 解析图片来源：地址原样交给 Telegram，本地文件与随机抽取转成上传源。 */
async function imageInput(source: CronImageSource): Promise<string | InputFile | CronDeliveryOutcome> {
  if (source.kind === "url") return source.url;
  if (source.kind === "path") return localUpload(source.path, TELEGRAM_PHOTO_UPLOAD_MAX_BYTES);
  const pick: RandomImagePick = await pickRandomImage(source.directory ?? getRandomImageDirectory());
  switch (pick.status) {
    case "ok":
      return new InputFile(pick.bytes, pick.fileName);
    case "missingDirectory":
      return { kind: "permanent", detail: "the random image directory is missing" };
    case "empty":
      return { kind: "permanent", detail: "the random image directory has no pictures" };
    case "tooLarge":
      return { kind: "permanent", detail: `the drawn picture ${pick.fileName} exceeds the Telegram upload limit` };
  }
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
 * 投递一个动作一次。`rand_image` 每次调用都重新抽取；抽不出或本地文件不可用按不可
 * 重试失败返回。signal 取消在途请求（停机超时）。
 */
export async function deliverCronAction(
  task: Readonly<CronTask>,
  action: Readonly<CronAction>,
  signal: AbortSignal
): Promise<CronDeliveryOutcome> {
  const chatId: number = task.chatId;
  switch (action.type) {
    case "send_message":
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendMessage(
        chatId,
        action.content,
        { message_thread_id: task.messageThreadId },
        ...signalArgs(requestSignal)
      ), signal);
    case "send_image": {
      const photo: string | InputFile | CronDeliveryOutcome = await imageInput(action.source);
      if (isOutcome(photo)) return photo;
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendPhoto(
        chatId,
        photo,
        { caption: action.content, message_thread_id: task.messageThreadId },
        ...signalArgs(requestSignal)
      ), signal);
    }
    case "send_file": {
      const document: string | InputFile | CronDeliveryOutcome = await fileInput(action.source);
      if (isOutcome(document)) return document;
      return send(chatId, (requestSignal?: AbortSignal): Promise<Message> => bot.api.sendDocument(
        chatId,
        document,
        { caption: action.content, message_thread_id: task.messageThreadId },
        ...signalArgs(requestSignal)
      ), signal);
    }
  }
}
