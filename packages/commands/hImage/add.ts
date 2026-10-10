/**
 * `/h_image add`：把被回复消息里的图（连同同一相册里已见过的其余几张）收进随机图库。
 *
 * 发起身份要有 isCanAddHImage（超级管理员恒有）。handler 同步收集候选并交给延迟命令执行器
 * 的 background 档；任务先列一次图库目录拿到张数，再在 H_IMAGE_ADD_TASK_BUDGET_MS 的
 * 总预算内按 H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE 张一页处理，内存里至多同时有一页的图：
 * 一页内同时下载，已知超过 RANDOM_IMAGE_MAX_BYTES 的不下载，其余经共享的 Telegram 文件下载
 * 读进有界内存，再按 `sendPhoto` 的尺寸门槛（isSendablePhotoDimensions）过一道闸；整页结算后
 * 按候选顺序逐张按字节嗅探格式写进图库（infra/randomImage.ts），写完才开始下一页。
 * 结果只回一句汇总（新收张数、收图前图库张数，以及跳过、尺寸不合规与失败的张数），
 * 走默认自动清理；停机取消时静默收场。
 *
 * 同批候选按 file_unique_id 去重；与图库的去重在下载后由 storeRandomImage
 * 按内容 SHA-256 文件名判定，不读取已有图片，也不按 Telegram 标识查询图库。
 */

import type { CommandContext, Context } from "grammy";
import type { Message } from "grammy/types";
import {
  H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE,
  H_IMAGE_ADD_DOWNLOAD_TIMEOUT_MS,
  H_IMAGE_ADD_METADATA_TIMEOUT_MS,
  H_IMAGE_ADD_TASK_BUDGET_MS,
} from "../../consts/hImage";
import { RANDOM_IMAGE_MAX_BYTES } from "../../consts/randomImage";
import { chatAtmosphere } from "../../infra/atmosphere";
import { logger } from "../../infra/logger";
import { mediaGroupImagesIn } from "../../infra/mediaGroups";
import { readImageDimensions } from "../../infra/image";
import { isRandomImageDirectory, readRandomImageLibrary, storeRandomImage } from "../../infra/randomImage";
import { getAssetConfig } from "../../config/assets";
import { sendCommandMessage } from "../../infra/telegram";
import { downloadTelegramFileBytes } from "../../infra/telegram/fileDownload";
import { currentUpdateAbortSignal } from "../../infra/updateContext";
import { isTimeoutAbort, signalWithTimeout } from "../../libs/abortSignal";
import { runBoundedSettledBatch } from "../../libs/boundedSettledBatch";
import type { BoundedBatchExecution, BoundedBatchResult } from "../../libs/boundedSettledBatch";
import { explicitReplyTo, forumTopicThreadId } from "../../libs/forumTopic";
import { isSendablePhotoDimensions, messageImageCandidate } from "../../libs/telegramImage";
import type { AtmosphereTexts } from "../../types/atmosphere";
import type { CachedUser } from "../../types/chatState";
import type { HImageAddOutcome, HImageAddRequest, ImageDimensions, MessageImageCandidate } from "../../types/hImage";
import type { RandomImageLibrary, StoreRandomImageResult } from "../../types/randomImage";
import type { TelegramFileDownloadResult } from "../../types/telegram";
import { rejectUnlessPermitted } from "../commandActor";
import { submitDeferredCommand } from "../deferredCommands";

/** 被回复的那张图在前，再补上同一相册里已见过的其余几张；按 file_unique_id 去重。 */
function collectCandidates(chatId: number, replied: Message): MessageImageCandidate[] {
  const candidates: MessageImageCandidate[] = [];
  const own: MessageImageCandidate | undefined = messageImageCandidate(replied);
  if (own !== undefined) candidates.push(own);
  if (replied.media_group_id === undefined) return candidates;
  for (const item of mediaGroupImagesIn(chatId, replied.media_group_id)) {
    if (!candidates.some((candidate: MessageImageCandidate): boolean => candidate.fileUniqueId === item.fileUniqueId)) {
      candidates.push(item);
    }
  }
  return candidates;
}

/** 一张图下载并过完尺寸闸的结果：待写盘的字节，或不再写盘的结局。 */
type DownloadedImage = Uint8Array | "invalidDimensions" | "failed";

/**
 * 下载一张图并过尺寸闸：返回待写盘的字节，或不再写盘的结局。失败都计为 failed：
 * 超限与空文件不记日志，单张的两段下载超时与其它失败记日志，取消与整批预算超时不记日志
 * （停机取消由 addRandomImages 在整页结算后收场）。
 *
 * 去重排在下载之后：图库文件名是内容的 SHA-256（见 infra/randomImage.ts 的
 * storeRandomImage）。已收录的图同样会被下载一次；同一张图换个人转发
 * （`file_unique_id` 不同）也判成重复。
 */
async function downloadImage(candidate: MessageImageCandidate, signal: AbortSignal): Promise<DownloadedImage> {
  try {
    if (candidate.fileSize !== undefined && candidate.fileSize > RANDOM_IMAGE_MAX_BYTES) return "failed";
    const download: TelegramFileDownloadResult = await downloadTelegramFileBytes({
      fileId: candidate.fileId,
      maxBytes: RANDOM_IMAGE_MAX_BYTES,
      metadataTimeoutMs: H_IMAGE_ADD_METADATA_TIMEOUT_MS,
      downloadTimeoutMs: H_IMAGE_ADD_DOWNLOAD_TIMEOUT_MS,
      signal,
    });
    if (download.status !== "ok") {
      if (download.status !== "tooLarge" && download.status !== "empty") {
        logger.error(`Failed to download a picture for /h_image add (${download.status}).`);
      }
      return "failed";
    }
    // 尺寸闸排在写盘之前，按 isSendablePhotoDimensions 判定 `sendPhoto` 的尺寸门槛。
    const dimensions: ImageDimensions | null = await readImageDimensions(download.bytes);
    if (dimensions === null) return "failed";
    if (!isSendablePhotoDimensions(dimensions)) return "invalidDimensions";
    return download.bytes;
  } catch (error: unknown) {
    if (!signal.aborted) logger.error("Failed to collect a picture for /h_image add:", error);
    return "failed";
  }
}

/**
 * 把一张已下载的图写进图库；写盘失败只记日志并计为 failed。同一页按候选顺序逐张调用，
 * 同批内容相同的后一张因此报 existing。
 */
async function storeImage(directory: string, bytes: Uint8Array): Promise<HImageAddOutcome> {
  try {
    const stored: StoreRandomImageResult = await storeRandomImage(directory, bytes);
    if (stored.status === "stored") return "added";
    return stored.status === "existing" ? "existing" : "failed";
  } catch (error: unknown) {
    logger.error("Failed to store a picture for /h_image add:", error);
    return "failed";
  }
}

/** 先列一遍图库目录，再在总预算内按页收图，最后回一句汇总。 */
async function addRandomImages(request: HImageAddRequest): Promise<void> {
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = chatAtmosphere().H_IMAGE_TEXTS;
  const directory: string = getAssetConfig().randomHImageDirectory;
  if (!await isRandomImageDirectory(directory)) {
    await sendCommandMessage({
      chatId: request.chatId,
      text: texts.missingDirectory,
      replyToMessageId: request.messageId,
      messageThreadId: request.messageThreadId,
    });
    return;
  }
  const library: RandomImageLibrary = await readRandomImageLibrary(directory);
  const signal: AbortSignal = signalWithTimeout(currentUpdateAbortSignal(), H_IMAGE_ADD_TASK_BUDGET_MS);
  const candidates: readonly MessageImageCandidate[] = request.candidates;
  let added: number = 0;
  let existing: number = 0;
  let invalidDimensions: number = 0;
  let failed: number = 0;
  for (let start: number = 0; start < candidates.length; start += H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE) {
    if (signal.aborted) {
      // 停机取消整批静默收场；预算耗尽后剩下的图直接记为失败。
      if (!isTimeoutAbort(signal)) return;
      failed += candidates.length - start;
      break;
    }
    const downloads: BoundedBatchResult<MessageImageCandidate, DownloadedImage>[] =
      await runBoundedSettledBatch({
        items: candidates.slice(start, start + H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE),
        maxConcurrent: H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE,
        execute: ({ item }: BoundedBatchExecution<MessageImageCandidate>): Promise<DownloadedImage> =>
          downloadImage(item, signal),
      });
    // 停机取消时这一页已下载的图也不再写盘。
    if (signal.aborted && !isTimeoutAbort(signal)) return;
    for (const download of downloads) {
      // downloadImage 自行结算全部异常，不会 reject。
      const image: DownloadedImage = download.status === "fulfilled" ? download.value : "failed";
      const outcome: HImageAddOutcome = typeof image === "string" ? image : await storeImage(directory, image);
      if (outcome === "added") added++;
      else if (outcome === "existing") existing++;
      else if (outcome === "invalidDimensions") invalidDimensions++;
      else failed++;
    }
  }
  await sendCommandMessage({
    chatId: request.chatId,
    text: texts.addResult({ added, librarySize: library.size, existing, invalidDimensions, failed }),
    replyToMessageId: request.messageId,
    messageThreadId: request.messageThreadId,
  });
}

/** 处理 `/h_image add`：校验权限与回复目标，接纳后立即返回，满额时回「稍后再试」。 */
export async function handleHImageAddCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const atmosphere: AtmosphereTexts = chatAtmosphere();
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = atmosphere.H_IMAGE_TEXTS;
  const actor: CachedUser | undefined = await rejectUnlessPermitted(
    ctx,
    "isCanAddHImage",
    (actorLabel: string): string => texts.addRejected(actorLabel)
  );
  if (actor === undefined) return;
  const replied: Message | undefined = explicitReplyTo(ctx.msg);
  if (replied === undefined) {
    await sendCommandMessage({ chatId, text: texts.addUsage, replyToMessageId: messageId });
    return;
  }
  const candidates: MessageImageCandidate[] = collectCandidates(chatId, replied);
  if (candidates.length === 0) {
    await sendCommandMessage({ chatId, text: texts.addNoImage, replyToMessageId: messageId });
    return;
  }
  const request: HImageAddRequest = { chatId, messageId, messageThreadId: forumTopicThreadId(ctx.msg), candidates };
  const accepted: boolean = submitDeferredCommand({
    priority: "background",
    task: (): Promise<void> => addRandomImages(request),
    errorLabel: "Unexpected error while processing /h_image add:",
  });
  if (!accepted) await sendCommandMessage({ chatId, text: texts.busy, replyToMessageId: messageId });
}
