/**
 * 按 Telegram file_id 取回一条语音消息的音频字节。
 *
 * 与 telegramImage.ts 的两处刻意差别：
 * 1. **不转码。** voice note 恒为 OGG/Opus，而多模态理解接口本来就收 audio/ogg；
 *    图片那侧要过 sharp 是因为两家视觉接口只认 jpg/png，这里没有对等约束。
 * 2. **上限更小。** 音频要 base64 内联进模型请求，编码后涨 4/3，而单次内联请求
 *    有 20 MB 的总上限——沿用媒体那条 16 MiB 会编出 21 MB 以上、整条请求被服务端
 *    拒收（见 consts/aiChat/voice.ts 的 VOICE_MAX_DOWNLOAD_BYTES）。
 *
 * 两步超时仍各自计时、invalidate signal 仍贯穿两步，理由与取图那条完全相同
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
  /** Telegram 声明的时长（秒），原样带进结果供诊断与提示词使用。 */
  durationSeconds: number;
  signal?: AbortSignal;
}

/**
 * 把 Telegram 声明的 mime 归一到供应商可接收的容器。
 *
 * 不把声明值原样转发：那是一段外部输入，写着什么就发什么等于让上游决定我们请求
 * 体里的字段。白名单外一律退回 OGG——voice note 的容器由 Telegram 客户端决定，
 * 事实上恒为 OGG/Opus。
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
  durationSeconds,
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
      durationSeconds,
    };
  } catch (error: unknown) {
    if (signal?.aborted === true) return null;
    logger.error("Error loading chat voice:", error);
    return null;
  }
}
