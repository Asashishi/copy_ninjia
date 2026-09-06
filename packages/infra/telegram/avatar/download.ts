import type { AvatarDownloadResult } from "../../../types/telegram";
import { AVATAR_MAX_DOWNLOAD_BYTES } from "../../../consts/telegram";
import { readBoundedResponseBytes } from "../../../libs/boundedResponse";
import type { BoundedResponseResult } from "../../../libs/boundedResponse";
import { logger } from "../../logger";
import { bot } from "../mainClient";
import type { HydratedTelegramFile } from "../mainClient";
import { runTelegramCategorizedRequest } from "../outboundGate";
import { avatarFetchSignal, telegramSignal } from "./shared";

/** 下载头像到有界内存；复用 Telegram 下载闸、取消和超时，不创建本地文件。 */
export async function downloadAvatarFile(
  fileId: string,
  targetId: number,
  signal?: AbortSignal
): Promise<AvatarDownloadResult> {
  const file: HydratedTelegramFile = await bot.api.getFile(fileId, telegramSignal(signal));
  if (!file.file_path) {
    logger.error(`getFile for target ${targetId}'s avatar returned no file_path`);
    return { status: "permanent-failure" };
  }
  const downloadUrl: string = file.getUrl();
  const imgRes: Response = await runTelegramCategorizedRequest({
    category: "download",
    signal: avatarFetchSignal(signal),
    execute: (requestSignal: AbortSignal): Promise<Response> => fetch(downloadUrl, {
      redirect: "error",
      signal: requestSignal,
    }),
  });
  if (!imgRes.ok) {
    logger.error(`Failed to download avatar file (${imgRes.status}): ${file.file_path}`);
    return { status: "transient-failure" };
  }
  const download: BoundedResponseResult = await readBoundedResponseBytes(imgRes, AVATAR_MAX_DOWNLOAD_BYTES);
  if (!download.ok) {
    logger.error(`Avatar file exceeded the download limit (${download.observedBytes} bytes): ${file.file_path}`);
    return { status: "permanent-failure" };
  }
  return { status: "ok", bytes: download.bytes };
}
