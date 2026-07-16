/**
 * 群聊媒体（图片/贴纸/GIF）的异步描述：下载 Telegram 文件，按需转码成
 * 视觉接口通吃的 jpg/png（见 libs/image.ts），喂给 Gemini 的视觉输入
 * （inlineData），产出一行简短中文描述，供 workers/aiChatWorker.ts 的 recordChatMedia 把
 * 对话缓存里的占位文本替换掉，也供 ai/stickerCatalog.ts 生成机器人自己
 * 贴纸目录的描述条目。跑在 AI Worker 线程里（调用方就是它）。
 *
 * 失败一律返回 null、绝不抛错——调用方按各自的兜底处理（图片退化成
 * 「[图片]」占位、贴纸退化成原有的元数据行、GIF 退化成失败占位），转录里
 * 至少留下痕迹，AI 流水线不因一份媒体挂掉。
 */

import { logger } from "../infra/logger";
import { bot, buildFileDownloadUrl } from "../infra/telegram";
import { extractOutputText, requestGeminiResponse } from "./gemini";
import { sanitizeInline, truncateAtClauseBoundary } from "../libs/text";
import { prepareVisionImage, type VisionImage } from "../libs/image";
import { descriptionCache } from "../cache/imageDescription";
import {
  ANIMATION_DESCRIPTION_PROMPT,
  IMAGE_DESCRIPTION_MAX_CHARS,
  IMAGE_DESCRIPTION_PROMPT,
  MEDIA_DESCRIPTION_CACHE_MAX,
  MEDIA_DESCRIPTION_CACHE_TTL_MS,
  MEDIA_DESCRIPTION_MAX_TOKENS,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_MAX_DOWNLOAD_BYTES,
  SHORT_MEDIA_DESCRIPTION_MAX_CHARS,
  GEMINI_MEDIA_MODEL,
  STICKER_DESCRIPTION_PROMPT,
} from "../consts/aiChat";
import type { MediaKind } from "../types";

/** 按媒体类型选喂给视觉模型的描述指令，三者风格/侧重点不同。 */
function promptFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return STICKER_DESCRIPTION_PROMPT;
    case "animation":
      return ANIMATION_DESCRIPTION_PROMPT;
    default:
      return IMAGE_DESCRIPTION_PROMPT;
  }
}

/** 按媒体类型选描述入缓存前的截断上限：贴纸/GIF 更短，见
 *  SHORT_MEDIA_DESCRIPTION_MAX_CHARS 注释。 */
function maxCharsFor(kind: MediaKind): number {
  return kind === "photo" ? IMAGE_DESCRIPTION_MAX_CHARS : SHORT_MEDIA_DESCRIPTION_MAX_CHARS;
}

/**
 * 下载并描述一份媒体（带 file_unique_id 去重缓存，见 descriptionCache）。
 * 图片/贴纸/GIF 共用同一份缓存——键空间不冲突（file_unique_id 本就是
 * Telegram 全局唯一），且同一份媒体不会同时是两种类型。
 * @param kind 媒体类型，决定用哪份视觉提示词与描述长度上限。
 * @param fileId 要下载的 Telegram file_id：图片是本体；贴纸是本体（静态）
 *   或缩略图（动态/视频，见 ai/stickerSets.ts 的 pickStickerVisionSource）；
 *   GIF 是缩略图（本项目无法解码 mp4/gif 抽帧，只能分析封面帧）。
 * @param fileUniqueId 缓存去重键：图片用同档位的 file_unique_id；贴纸/GIF
 *   固定用媒体自身（而非缩略图）的 file_unique_id，保证同一份贴纸/GIF
 *   无论走本体还是缩略图素材，描述都记在同一个键下。
 * @returns 压成单行、截断后的中文描述；下载/转码/解析任一步失败则 null。
 */
export function describeMedia(kind: MediaKind, fileId: string, fileUniqueId: string): Promise<string | null> {
  const cached: Promise<string | null> | undefined = descriptionCache.get(fileUniqueId);
  if (cached) return cached;

  const pending: Promise<string | null> = describeMediaUncached(kind, fileId).then((description: string | null) => {
    // 按引用而非按 key 删——与下面 TTL 清理同样的理由：这份 pending 在解析
    // 期间可能已经因为超过 500 条上限被淘汰、又被新的并发请求重新插入了
    // 一份新 pending，此时这里必须认得出"当前占着这个 key 的不是自己"，
    // 不能把新插入的那份连锅端掉（否则新请求的合并会落空，还会误删一份
    // 可能已经解析成功、本该继续留在缓存里的有效结果）。
    if (description === null && descriptionCache.get(fileUniqueId) === pending) {
      descriptionCache.delete(fileUniqueId);
    }
    return description;
  });
  descriptionCache.set(fileUniqueId, pending);
  // 超上限就淘汰最早插入的条目（Map 迭代顺序即插入顺序），不搞真 LRU——
  // 热门媒体重发不刷新位置，靠上限本身足够大兜底。
  if (descriptionCache.size > MEDIA_DESCRIPTION_CACHE_MAX) {
    descriptionCache.delete(descriptionCache.keys().next().value!);
  }
  // 双保险：低流量长期运行下，条目数可能一直摸不到 MEDIA_DESCRIPTION_CACHE_MAX
  // 却又长期占着内存不放，TTL 到期主动清掉。按引用而非按 key 删——期间这份
  // 媒体若已因解析失败被摘掉、又被新请求重新插入了一份新 pending，不能把
  // 新的错删。
  setTimeout(() => {
    if (descriptionCache.get(fileUniqueId) === pending) {
      descriptionCache.delete(fileUniqueId);
    }
  }, MEDIA_DESCRIPTION_CACHE_TTL_MS).unref();
  return pending;
}

async function describeMediaUncached(kind: MediaKind, fileId: string): Promise<string | null> {
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      logger.error(`getFile for chat media (kind=${kind}) ${fileId} returned no file_path`);
      return null;
    }
    // 只记录 file_path，绝不能把完整下载 URL 打进日志——URL 里嵌着 bot token
    // （见 infra/telegram.ts 的 buildFileDownloadUrl 注释）。
    const res: Response = await fetch(buildFileDownloadUrl(file.file_path), {
      signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error(`Failed to download chat media (kind=${kind}, ${res.status}): ${file.file_path}`);
      return null;
    }
    const bytes: ArrayBuffer = await res.arrayBuffer();
    if (bytes.byteLength > MEDIA_MAX_DOWNLOAD_BYTES) {
      // 调用方已按大小预筛过素材来源，走到这里说明元数据缺失或不实。
      logger.error(`Chat media (kind=${kind}) too large to describe (${bytes.byteLength} bytes): ${file.file_path}`);
      return null;
    }

    // 按魔数嗅探实际格式并按需转码（webp/gif -> png），不依赖 file_path 的
    // 扩展名——贴纸本体/缩略图的扩展名不总是可靠，见 libs/image.ts。
    const image: VisionImage | null = await prepareVisionImage(Buffer.from(bytes));
    if (!image) {
      logger.error(`Chat media (kind=${kind}) is an unsupported/unrecognized image format: ${file.file_path}`);
      return null;
    }
    const data: any = await requestGeminiResponse(
      {
        model: GEMINI_MEDIA_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: image.mime, data: image.bytes.toString("base64") } },
              { text: promptFor(kind) },
            ],
          },
        ],
        config: { maxOutputTokens: MEDIA_DESCRIPTION_MAX_TOKENS },
      },
      "Gemini image understanding API"
    );
    if (!data) return null;
    const description: string = sanitizeInline(extractOutputText(data));
    if (!description) return null;
    // 模型超限时收在子句边界而不是硬切——memory/stickers/ 里曾大批量出现
    // 「……以戏谑的口」式断在半句的目录条目，就是硬切造成的。
    return truncateAtClauseBoundary(description, maxCharsFor(kind));
  } catch (error: unknown) {
    logger.error(`Error describing chat media (kind=${kind}):`, error);
    return null;
  }
}
