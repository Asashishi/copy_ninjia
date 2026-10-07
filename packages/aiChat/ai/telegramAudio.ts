/**
 * 按 Telegram file_id 取回一条语音消息的音频字节。
 *
 * 与 telegramImage.ts 的两处差别：
 * 1. 不转码：音频字节原样返回。
 * 2. 上限更小：音频 base64 内联进模型请求，编码后体积增大，受同一份内联请求预算约束；
 *    语音另按 Worker 内存取更小的上限（见 consts/aiChat/voice.ts 的
 *    VOICE_MAX_DOWNLOAD_BYTES 与 consts/aiChat/media.ts 的 MEDIA_INLINE_REQUEST_MAX_BYTES）。
 *
 * 两步超时各自计时、invalidate signal 贯穿两步，与取图那条相同
 * （见 telegramImage.ts 的超时注释）。完整下载 URL 只存在于主线程请求边界，
 * Worker 只接收受上限约束的字节，不接触或记录 URL。
 *
 * 失败一律返回 null 并记一行英文日志；调用方按「这条语音解析不出来」降级。
 */

import {
  VOICE_DEFAULT_MIME,
  VOICE_MIME_TYPES,
} from "../../consts/aiChat/voice";
import { logger } from "../../infra/logger";
import { downloadTelegramFileFromMain } from "../../infra/telegram/workerClient";
import type { VoiceClip } from "../../types/media";
import type { TelegramWorkerDownloadFileResult } from "../../types/telegramWorker";

export interface DownloadTelegramVoiceParams {
  fileId: string;
  /** Telegram 声明的 mime_type；不在白名单内或缺失时退回 VOICE_DEFAULT_MIME。 */
  declaredMime: string | undefined;
  signal?: AbortSignal;
}

/**
 * 把 Telegram 声明的 mime 归一到 VOICE_MIME_TYPES 白名单内的容器：trim 并转小写后命中
 * 白名单则采用，缺失或白名单外退回 VOICE_DEFAULT_MIME。
 */
export function normalizeVoiceMime(declaredMime: string | undefined): string {
  if (declaredMime === undefined) return VOICE_DEFAULT_MIME;
  const normalized: string = declaredMime.trim().toLowerCase();
  return VOICE_MIME_TYPES.includes(normalized) ? normalized : VOICE_DEFAULT_MIME;
}

/** 取回一条语音的原始音频字节；任一步失败返回 null。 */
export async function downloadTelegramVoice({
  fileId,
  declaredMime,
  signal,
}: DownloadTelegramVoiceParams): Promise<VoiceClip | null> {
  try {
    const download: TelegramWorkerDownloadFileResult =
      await downloadTelegramFileFromMain({
        fileId,
        purpose: "voice",
        signal,
      });
    if (download.status !== "ok") {
      logger.error(`Chat voice download failed: ${download.status}.`);
      return null;
    }
    return {
      // 下载缓冲已由主线程转移所有权，不复制大音频载荷。
      bytes: download.bytes,
      mime: normalizeVoiceMime(declaredMime),
    };
  } catch (error: unknown) {
    if (signal?.aborted === true) return null;
    logger.error("Error loading chat voice:", error);
    return null;
  }
}
