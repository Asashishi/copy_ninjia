import { MEDIA_DOWNLOAD_TIMEOUT_MS, MEDIA_FILE_METADATA_TIMEOUT_MS, MEDIA_MAX_DOWNLOAD_BYTES } from "../../consts/aiChat/media";
import { logger } from "../../infra/logger";
import { bot } from "../../infra/telegram";
import type { HydratedTelegramFile } from "../../infra/telegram";
import { readBoundedResponseBytes, type BoundedResponseResult } from "../../libs/boundedResponse";
import { prepareVisionImage } from "../../libs/image";
import type { VisionImage } from "../../types/media";

export interface DownloadTelegramVisionImageParams {
  fileId: string;
  /** 只用于固定格式诊断日志，不得包含用户文本、URL 或 token。 */
  logLabel: string;
  signal?: AbortSignal;
}

/**
 * 把调用方的 invalidate signal 与一份**独立**的超时预算合成一个 signal。
 * 每次调用现取一个 `AbortSignal.timeout`，因此同一次下载里的两步不会共享
 * 同一个 deadline。
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout: AbortSignal = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * 通过 Telegram file_id 现取一张图片并规范成两家视觉接口都能接收的 jpeg/png。
 * 完整下载 URL 含 Bot Token，只在 fetch 调用的局部变量中存在，绝不返回、
 * 缓存或写日志。下载、转码前后都沿用媒体描述管线的 8 MiB 硬上限。
 */
export async function downloadTelegramVisionImage({
  fileId,
  logLabel,
  signal,
}: DownloadTelegramVisionImageParams): Promise<VisionImage | null> {
  try {
    // 两步各自计时，绝不共用一个 deadline：getFile 走共享 throttler 与
    // autoRetry，一次 429 退避就可能耗掉几十秒，共用时下载只剩残额、几乎立刻
    // abort。invalidate signal 仍要贯穿两步（见 docs/04-invariants.md 的 AI
    // chat invalidate 约束）。
    const file: HydratedTelegramFile = await bot.api.getFile(
      fileId,
      withTimeout(signal, MEDIA_FILE_METADATA_TIMEOUT_MS) as unknown as Parameters<typeof bot.api.getFile>[1]
    );
    if (!file.file_path) {
      logger.error(`getFile for ${logLabel} ${fileId} returned no file_path`);
      return null;
    }

    const response: Response = await fetch(file.getUrl(), {
      redirect: "error",
      signal: withTimeout(signal, MEDIA_DOWNLOAD_TIMEOUT_MS),
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
    if (signal?.aborted === true) return null;
    logger.error(`Error loading ${logLabel}:`, error);
    return null;
  }
}
