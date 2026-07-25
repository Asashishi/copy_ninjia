import type { File as TelegramFile } from "@grammyjs/types";
import { MEDIA_DOWNLOAD_TIMEOUT_MS, MEDIA_MAX_DOWNLOAD_BYTES } from "../consts/aiChat/media";
import { logger } from "../infra/logger";
import { bot, buildFileDownloadUrl } from "../infra/telegram";
import { readBoundedResponseBytes, type BoundedResponseResult } from "../libs/boundedResponse";
import { prepareVisionImage, type VisionImage } from "../libs/image";

export interface DownloadTelegramVisionImageParams {
  fileId: string;
  /** 只用于固定格式诊断日志，不得包含用户文本、URL 或 token。 */
  logLabel: string;
}

/**
 * 通过 Telegram file_id 现取一张图片并规范成 Gemini 可接收的 jpeg/png。
 * 完整下载 URL 含 Bot Token，只在 fetch 调用的局部变量中存在，绝不返回、
 * 缓存或写日志。下载、转码前后都沿用媒体描述管线的 8 MiB 硬上限。
 */
export async function downloadTelegramVisionImage({
  fileId,
  logLabel,
}: DownloadTelegramVisionImageParams): Promise<VisionImage | null> {
  try {
    const file: TelegramFile = await bot.api.getFile(fileId);
    if (!file.file_path) {
      logger.error(`getFile for ${logLabel} ${fileId} returned no file_path`);
      return null;
    }

    const response: Response = await fetch(buildFileDownloadUrl(file.file_path), {
      signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.error(`Failed to download ${logLabel} (${response.status}): ${file.file_path}`);
      return null;
    }

    const download: BoundedResponseResult = await readBoundedResponseBytes(response, MEDIA_MAX_DOWNLOAD_BYTES);
    if (!download.ok) {
      logger.error(`${logLabel} exceeded the download limit (${download.observedBytes} bytes): ${file.file_path}`);
      return null;
    }

    const image: VisionImage | null = await prepareVisionImage(Buffer.from(download.bytes));
    if (!image) {
      logger.error(`${logLabel} is an unsupported/unrecognized image format: ${file.file_path}`);
      return null;
    }
    if (image.bytes.byteLength > MEDIA_MAX_DOWNLOAD_BYTES) {
      logger.error(`Prepared ${logLabel} exceeded the size limit (${image.bytes.byteLength} bytes): ${file.file_path}`);
      return null;
    }
    return image;
  } catch (error: unknown) {
    logger.error(`Error loading ${logLabel}:`, error);
    return null;
  }
}
