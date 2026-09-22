import type { AvatarDownloadResult, TelegramFileDownloadResult } from "../../../types/telegram";
import {
  AVATAR_FETCH_TIMEOUT_MS,
  AVATAR_MAX_DOWNLOAD_BYTES,
} from "../../../consts/telegram";
import { logger } from "../../logger";
import { downloadTelegramFileBytes } from "../fileDownload";

/**
 * 下载头像到有界内存；复用共享的 Telegram 文件下载（download 类出站闸、取消与超时，
 * getFile 与下载各自按 AVATAR_FETCH_TIMEOUT_MS 计时），不创建本地文件。
 * 文件服务器的非 2xx 按可重试处理，其余失败按确定性失败处理。
 */
export async function downloadAvatarFile(
  fileId: string,
  targetId: number,
  signal?: AbortSignal
): Promise<AvatarDownloadResult> {
  const download: TelegramFileDownloadResult = await downloadTelegramFileBytes({
    fileId,
    maxBytes: AVATAR_MAX_DOWNLOAD_BYTES,
    metadataTimeoutMs: AVATAR_FETCH_TIMEOUT_MS,
    downloadTimeoutMs: AVATAR_FETCH_TIMEOUT_MS,
    signal,
  });
  switch (download.status) {
    case "ok":
      return download;
    case "missingPath":
      logger.error(`getFile for target ${targetId}'s avatar returned no file_path`);
      return { status: "permanent-failure" };
    case "httpError":
      logger.error(`Failed to download the avatar file of target ${targetId} (${download.httpStatus})`);
      return { status: "transient-failure" };
    case "tooLarge":
      logger.error(`Avatar file of target ${targetId} exceeded the download limit (${download.observedBytes} bytes)`);
      return { status: "permanent-failure" };
    case "empty":
      logger.error(`Avatar file of target ${targetId} downloaded empty`);
      return { status: "permanent-failure" };
  }
}
