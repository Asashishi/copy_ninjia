/**
 * `/h_image add`：把被回复消息里的图（连同同一相册里已见过的其余几张）收进随机图库。
 *
 * 发起身份要有 isCanAddHImage（超级管理员恒有）。handler 同步收集候选并交给延迟命令执行器
 * 的 background 档；任务先列一次图库目录拿到张数，再在
 * H_IMAGE_ADD_TASK_BUDGET_MS 的总预算内一张一张处理，内存里最多同时只有一张图：
 * 已知超过 10 MB 的不下载，其余经共享的 Telegram 文件下载读进有界内存，再按
 * `sendPhoto` 的尺寸门槛过一道闸（宽高之和 ≤ 10000、长宽比 ≤ 20），最后按字节嗅探格式写进
 * 图库（infra/randomImage.ts）。
 * 结果只回一句汇总（新收张数、收图前图库张数，以及跳过、尺寸不合规与失败的张数），
 * 30 秒后删除；停机取消时静默收场。
 *
 * 同批候选按 file_unique_id 去重；与图库的去重在下载后由 storeRandomImage
 * 按内容 SHA-256 文件名判定，不读取已有图片，也不按 Telegram 标识查询图库。
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
import { readImageDimensions } from "../../infra/image";
import { isRandomImageDirectory, readRandomImageLibrary, storeRandomImage } from "../../infra/randomImage";
import { getRandomHImageDirectory } from "../../infra/storage/stateStore";
import { sendCommandMessage } from "../../infra/telegram";
import { downloadTelegramFileBytes } from "../../infra/telegram/fileDownload";
import { currentUpdateAbortSignal } from "../../infra/updateContext";
import { isTimeoutAbort, signalWithTimeout } from "../../libs/abortSignal";
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

/** collectImage 的入参。 */
interface CollectImageParams {
  /** 已解析成绝对路径的图库目录。 */
  readonly directory: string;
  readonly candidate: MessageImageCandidate;
  readonly signal: AbortSignal;
}

/**
 * 收一张图；失败只记日志并计数，停机取消返回 stopped。
 *
 * 去重排在下载之后：图库文件名是内容的 SHA-256（见 infra/randomImage.ts 的
 * storeRandomImage），要算出这个名字就得先拿到字节。已收录的图同样会被下载一次；
 * 同一张图换个人转发、`file_unique_id` 不同，也照样判成重复。
 */
async function collectImage({
  directory,
  candidate,
  signal,
}: CollectImageParams): Promise<HImageAddOutcome> {
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
      if (download.status === "httpError" || download.status === "missingPath") {
        logger.error(`Failed to download a picture for /h_image add (${download.status}).`);
      }
      return "failed";
    }
    // 尺寸闸排在写盘之前：`sendPhoto` 要求宽高之和 ≤ 10000、长宽比 ≤ 20，字节闸
    // 拦不住这一档（一张 12000×40 的长条 PNG 只有几十 KB）。收进去的话，这张图
    // 日后被 `/h_image` 或 cron `rand_image` 抽中时只会静默发不出去，群里没有
    // 任何反馈，运维也无从知道图库里躺着一张永远发不出的图。
    const dimensions: ImageDimensions | null = await readImageDimensions(download.bytes);
    if (dimensions === null) return "failed";
    if (!isSendablePhotoDimensions(dimensions)) return "invalidDimensions";
    const stored: StoreRandomImageResult = await storeRandomImage(directory, download.bytes);
    if (stored.status === "stored") return "added";
    return stored.status === "existing" ? "existing" : "failed";
  } catch (error: unknown) {
    if (signal.aborted) return isTimeoutAbort(signal) ? "failed" : "stopped";
    logger.error("Failed to collect a picture for /h_image add:", error);
    return "failed";
  }
}

/** 先列一遍图库目录，再在总预算内逐张收图，最后回一句汇总。 */
async function addRandomImages(request: HImageAddRequest): Promise<void> {
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = chatAtmosphere(request.chatId).H_IMAGE_TEXTS;
  const directory: string = getRandomHImageDirectory();
  if (!await isRandomImageDirectory(directory)) {
    await sendCommandMessage({ chatId: request.chatId, text: texts.missingDirectory, replyToMessageId: request.messageId });
    return;
  }
  const library: RandomImageLibrary = await readRandomImageLibrary(directory);
  const signal: AbortSignal = signalWithTimeout(currentUpdateAbortSignal(), H_IMAGE_ADD_TASK_BUDGET_MS);
  let added: number = 0;
  let existing: number = 0;
  let invalidDimensions: number = 0;
  let failed: number = 0;
  for (const candidate of request.candidates) {
    // 预算耗尽后剩下的图直接记为失败；停机取消则整批静默收场。
    const outcome: HImageAddOutcome = signal.aborted
      ? (isTimeoutAbort(signal) ? "failed" : "stopped")
      : await collectImage({ directory, candidate, signal });
    if (outcome === "stopped") return;
    if (outcome === "added") added++;
    else if (outcome === "existing") existing++;
    else if (outcome === "invalidDimensions") invalidDimensions++;
    else failed++;
  }
  await sendCommandMessage({
    chatId: request.chatId,
    text: texts.addResult({ added, librarySize: library.size, existing, invalidDimensions, failed }),
    replyToMessageId: request.messageId,
  });
}

/** 处理 `/h_image add`：校验权限与回复目标，接纳后立即返回，满额时回「稍后再试」。 */
export async function handleHImageAddCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
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
  const accepted: boolean = submitDeferredCommand(
    "background",
    (): Promise<void> => addRandomImages(request),
    "Unexpected error while processing /h_image add:"
  );
  if (!accepted) await sendCommandMessage({ chatId, text: texts.busy, replyToMessageId: messageId });
}
