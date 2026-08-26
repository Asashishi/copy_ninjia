import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../consts/aiChat/media";
import { logger } from "../../infra/logger";
import { downloadTelegramFileFromMain } from "../../infra/telegram/workerClient";
import { prepareVisionImage } from "../../libs/image";
import type { VisionImage } from "../../types/media";
import type { TelegramWorkerDownloadFileResult } from "../../types/telegramWorker";

export interface DownloadTelegramVisionImageParams {
  fileId: string;
  /** 只用于固定格式诊断日志，不得包含用户文本、URL 或 token。 */
  logLabel: string;
  signal?: AbortSignal;
}

/**
 * 通过 Telegram file_id 现取一张图片并规范成两家视觉接口都能接收的 jpeg/png。
 * getFile 与下载均由主线程能力边界完成，Worker 只收到受上限约束的字节；下载、
 * 转码前后都沿用媒体描述管线的 8 MiB 硬上限。
 */
export async function downloadTelegramVisionImage({
  fileId,
  logLabel,
  signal,
}: DownloadTelegramVisionImageParams): Promise<VisionImage | null> {
  try {
    // 主线程内的两步各自计时，绝不共用一个 deadline：getFile 走自适应 429 队列，
    // 一次退避就可能耗掉几十秒，共用时下载只剩残额、几乎立刻
    // abort。invalidate signal 仍要贯穿两步（见 docs/cn/04-invariants.md 的 AI
    // chat invalidate 约束）。
    const download: TelegramWorkerDownloadFileResult =
      await downloadTelegramFileFromMain({
        fileId,
        purpose: "vision",
        signal,
      });
    if (download.status !== "ok") {
      logger.error(`${logLabel} download failed: ${download.status}.`);
      return null;
    }

    // 下载缓冲已从主线程转移并归本 Worker 独占，直接传递同一个 Uint8Array，
    // 不为单张大图建立额外视图或复制字节。
    const image: VisionImage | null = await prepareVisionImage(download.bytes);
    if (!image) {
      logger.error(`${logLabel} is an unsupported/unrecognized image format.`);
      return null;
    }
    if (image.bytes.byteLength > MEDIA_MAX_DOWNLOAD_BYTES) {
      logger.error(`Prepared ${logLabel} exceeded the size limit (${image.bytes.byteLength} bytes).`);
      return null;
    }
    return image;
  } catch (error: unknown) {
    if (signal?.aborted === true) return null;
    logger.error(`Error loading ${logLabel}:`, error);
    return null;
  }
}
