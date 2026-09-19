/**
 * `/h_image add`：把被回复消息里的图（连同同一相册里已见过的其余几张）收进随机图库。
 *
 * 发起身份要有 isCanAddHImage（超级管理员恒有）。handler 同步收集候选并交给延迟命令执行器
 * 的 background 档；任务在 H_IMAGE_ADD_TASK_BUDGET_MS 的总预算内一张一张处理，内存里最多
 * 同时只有一张图：图库里已有（同一 file_unique_id）的跳过，已知超过 10 MB 的不下载，其余
 * 经共享的 Telegram 文件下载读进有界内存，再按字节嗅探格式写进图库（infra/randomImage.ts）。
 * 结果只回一句汇总（新收张数、收图前图库张数，以及跳过与失败的张数），30 秒后删除；停机
 * 取消时静默收场。
 */

import type { CommandContext, Context } from "grammy";
import type { Message } from "grammy/types";
import {
  H_IMAGE_ADD_DOWNLOAD_TIMEOUT_MS,
  H_IMAGE_ADD_METADATA_TIMEOUT_MS,
  H_IMAGE_ADD_TASK_BUDGET_MS,
} from "../../consts/hImage";
import { RANDOM_IMAGE_MAX_BYTES } from "../../consts/randomImage";
import { chatAtmosphere } from "../../infra/atmosphere";
import { logger } from "../../infra/logger";
import { mediaGroupImagesIn } from "../../infra/mediaGroups";
import { countRandomImages, hasStoredRandomImage, isRandomImageDirectory, storeRandomImage } from "../../infra/randomImage";
import { getRandomImageDirectory } from "../../infra/storage/stateStore";
import { sendCommandMessage } from "../../infra/telegram";
import { downloadTelegramFileBytes } from "../../infra/telegram/fileDownload";
import { currentUpdateAbortSignal } from "../../infra/updateContext";
import { isTimeoutAbort, signalWithTimeout } from "../../libs/abortSignal";
import { explicitReplyTo, forumTopicThreadId } from "../../libs/forumTopic";
import { messageImageCandidate } from "../../libs/telegramImage";
import type { AtmosphereTexts } from "../../types/atmosphere";
import type { CachedUser } from "../../types/chatState";
import type { HImageAddOutcome, HImageAddRequest, MessageImageCandidate } from "../../types/hImage";
import type { StoreRandomImageResult } from "../../types/randomImage";
import type { TelegramFileDownloadResult } from "../../types/telegram";
import { formatUserLabel } from "../../users/userLabel";
import { hasCommandPermission, resolveCommandActor } from "../commandActor";
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

/** 收一张图；失败只记日志并计数，停机取消返回 stopped。 */
async function collectImage(
  directory: string,
  candidate: MessageImageCandidate,
  signal: AbortSignal
): Promise<HImageAddOutcome> {
  try {
    if (await hasStoredRandomImage(directory, candidate.fileUniqueId)) return "existing";
    if (candidate.fileSize !== undefined && candidate.fileSize > RANDOM_IMAGE_MAX_BYTES) return "failed";
    const download: TelegramFileDownloadResult = await downloadTelegramFileBytes({
      fileId: candidate.fileId,
      maxBytes: RANDOM_IMAGE_MAX_BYTES,
      metadataTimeoutMs: H_IMAGE_ADD_METADATA_TIMEOUT_MS,
      downloadTimeoutMs: H_IMAGE_ADD_DOWNLOAD_TIMEOUT_MS,
      signal,
    });
    if (download.status !== "ok") {
      if (download.status === "httpError" || download.status === "missingPath") {
        logger.error(`Failed to download a picture for /h_image add (${download.status}).`);
      }
      return "failed";
    }
    const stored: StoreRandomImageResult = await storeRandomImage(directory, candidate.fileUniqueId, download.bytes);
    return stored.status === "stored" ? "added" : "failed";
  } catch (error: unknown) {
    if (signal.aborted) return isTimeoutAbort(signal) ? "failed" : "stopped";
    logger.error("Failed to collect a picture for /h_image add:", error);
    return "failed";
  }
}

/** 先数一遍图库，再在总预算内逐张收图，最后回一句汇总。 */
export async function addRandomImages(request: HImageAddRequest): Promise<void> {
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = chatAtmosphere(request.chatId).H_IMAGE_TEXTS;
  const directory: string = getRandomImageDirectory();
  if (!await isRandomImageDirectory(directory)) {
    await sendCommandMessage({ chatId: request.chatId, text: texts.missingDirectory, replyToMessageId: request.messageId });
    return;
  }
  const librarySize: number = await countRandomImages(directory);
  const signal: AbortSignal = signalWithTimeout(currentUpdateAbortSignal(), H_IMAGE_ADD_TASK_BUDGET_MS);
  let added: number = 0;
  let existing: number = 0;
  let failed: number = 0;
  for (const candidate of request.candidates) {
    // 预算耗尽后剩下的图直接记为失败；停机取消则整批静默收场。
    const outcome: HImageAddOutcome = signal.aborted
      ? (isTimeoutAbort(signal) ? "failed" : "stopped")
      : await collectImage(directory, candidate, signal);
    if (outcome === "stopped") return;
    if (outcome === "added") added++;
    else if (outcome === "existing") existing++;
    else failed++;
  }
  await sendCommandMessage({
    chatId: request.chatId,
    text: texts.addResult({ added, librarySize, existing, failed }),
    replyToMessageId: request.messageId,
  });
}

/** 处理 `/h_image add`：校验权限与回复目标，接纳后立即返回，满额时回「稍后再试」。 */
export async function handleHImageAddCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = atmosphere.H_IMAGE_TEXTS;
  if (!hasCommandPermission(ctx, "isCanAddHImage")) {
    const actor: CachedUser | undefined = resolveCommandActor(ctx);
    const label: string = actor === undefined ? atmosphere.NOTICE_TEXTS.unknownActor : formatUserLabel(actor, atmosphere);
    await sendCommandMessage({ chatId, text: texts.addRejected(label), replyToMessageId: messageId });
    return;
  }
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
  const accepted: boolean = submitDeferredCommand(
    "background",
    (): Promise<void> => addRandomImages(request),
    "Unexpected error while processing /h_image add:"
  );
  if (!accepted) await sendCommandMessage({ chatId, text: texts.busy, replyToMessageId: messageId });
}
