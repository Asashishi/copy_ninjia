/**
 * 群聊媒体（图片/贴纸/GIF）的异步描述：下载 Telegram 文件，按需转码成
 * 视觉接口通吃的 jpg/png（见 libs/image.ts），喂给当前供应商的视觉
 * 接口，产出一行简短中文描述，供 workers/aiChat/mediaIngest.ts 的 recordChatMedia 把
 * 对话缓存里的占位文本替换掉，也供 aiChat/ai/stickers/catalog.ts 生成机器人自己
 * 贴纸目录的描述条目。跑在 AI Worker 线程里（调用方就是它）。
 *
 * 失败一律返回 null、绝不抛错——调用方按各自的兜底处理（图片退化成
 * 「[图片]」占位、贴纸退化成原有的元数据行、GIF 退化成失败占位），转录里
 * 至少留下痕迹，AI 流水线不因一份媒体挂掉。
 */

import { logger } from "../../infra/logger";
import { chatAiProvider } from "../provider";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import { transientDescriptionCache } from "../../cache/workers/aiChat/imageDescription";
import {
  IMAGE_DESCRIPTION_MAX_CHARS,
  MEDIA_DESCRIPTION_ERROR_LABEL,
  SHORT_MEDIA_DESCRIPTION_MAX_CHARS,
} from "../../consts/aiChat/media";
import { ANIMATION_DESCRIPTION_PROMPT, IMAGE_DESCRIPTION_PROMPT, STICKER_DESCRIPTION_PROMPT } from "../../consts/aiChat/prompts/media";
import type { MediaKind } from "../../types/media";
import { downloadTelegramVisionImage } from "./telegramImage";
import { runMediaTask } from "./mediaTaskRunner";
import type { VisionImage } from "../../types/media";
import type { AiTextResult } from "../../types/aiChat/provider";

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
 * 下载并描述一份未命中本地贴纸目录的媒体（带 file_unique_id 临时去重
 * 缓存，见 transientDescriptionCache）。图片、GIF 与非白名单贴纸共用这份
 * MEDIA_DESCRIPTION_CACHE_MAX 项的 LRU 缓存——键空间不冲突（file_unique_id
 * 本就是 Telegram 全局唯一），且同一份媒体不会同时是两种类型。白名单贴纸
 * 由调用方先查 stickerCatalog 的常驻目录，不会走到这里。
 * @param kind 媒体类型，决定用哪份视觉提示词与描述长度上限。
 * @param fileId 要下载的 Telegram file_id：图片是本体；贴纸是本体（静态）
 *   或缩略图（动态/视频，见 aiChat/ai/stickers/describe.ts 的 pickStickerVisionSource）；
 *   GIF 是缩略图（本项目无法解码 mp4/gif 抽帧，只能分析封面帧）。
 * @param fileUniqueId 缓存去重键：图片用同档位的 file_unique_id；贴纸/GIF
 *   固定用媒体自身（而非缩略图）的 file_unique_id，保证同一份贴纸/GIF
 *   无论走本体还是缩略图素材，描述都记在同一个键下。
 * @returns 压成单行、截断后的中文描述；下载/转码/解析任一步失败则 null。
 */
export function describeMedia(kind: MediaKind, fileId: string, fileUniqueId: string): Promise<string | null> {
  const cached: Promise<string | null> | undefined = transientDescriptionCache.get(fileUniqueId);
  if (cached) return cached;

  const pending: Promise<string | null> = runMediaTask(
    (): Promise<AiTextResult> => describeMediaUncached(kind, fileId)
  ).then((attempt: AiTextResult | undefined): string | null => {
    // 执行槽位和等待队列都满时返回 undefined；按普通解析失败降级，不再
    // 启动下载、转码或视觉 API 请求。
    const result: string | null = attempt?.ok === true ? attempt.text : null;
    // 按引用而非按 key 删，用 peek 而不是 get——不能让这次内部核对被当成
    // 一次真实访问去刷新淘汰顺位。这份 pending 在解析期间可能已经因为超过
    // 容量上限被淘汰、又被新的并发请求重新插入了一份新 pending，此时这里
    // 必须认得出"当前占着这个 key 的不是自己"，不能把新插入的那份连锅
    // 端掉（否则新请求的合并会落空，还会误删一份可能已经解析成功、本该
    // 继续留在缓存里的有效结果）。
    if (result === null && transientDescriptionCache.peek(fileUniqueId) === pending) {
      transientDescriptionCache.delete(fileUniqueId);
    }
    return result;
  });
  // 写入即满足容量上限的淘汰（超容量删最久未使用的一个），见
  // cache/workers/aiChat/imageDescription.ts 的 LruCache 用法。
  transientDescriptionCache.set(fileUniqueId, pending);
  return pending;
}

/**
 * 为白名单贴纸目录生成一条常驻描述。目录自身负责按 file_unique_id 去重、
 * 持久化和线上变更对账，因此这里刻意绕过 transientDescriptionCache 临时
 * 缓存；成功后调用方会立即写入 stickerCatalog，消息记录随后可直接命中
 * 常驻目录。失败结果额外声明目录层能否重新采样：供应商 SDK 已耗尽 HTTP 重试时
 * 禁止再次套完整请求，下载/排队或成功响应正文不可用时则允许。
 */
export function describeMediaForStickerCatalog(fileId: string): Promise<AiTextResult> {
  return runMediaTask(
    (): Promise<AiTextResult> => describeMediaUncached("sticker", fileId)
  ).then((result: AiTextResult | undefined): AiTextResult =>
    result ?? { ok: false, retryable: true }
  );
}

async function describeMediaUncached(kind: MediaKind, fileId: string): Promise<AiTextResult> {
  try {
    const image: VisionImage | null = await downloadTelegramVisionImage({ fileId, logLabel: `chat media (kind=${kind})` });
    if (!image) return { ok: false, retryable: true };
    return await chatAiProvider().describeVision({
      prompt: promptFor(kind),
      image,
      errorLabel: MEDIA_DESCRIPTION_ERROR_LABEL,
      normalize: (text: string): string => {
        const description: string = sanitizeInline(text);
        if (!description) return "";
        // 模型超限时收在子句边界而不是硬切——memory/stickers/ 里曾大批量出现
        // 「……以戏谑的口」式断在半句的目录条目，就是硬切造成的。
        return truncateAtClauseBoundary(description, maxCharsFor(kind));
      },
    });
  } catch (error: unknown) {
    logger.error(`Error describing chat media (kind=${kind}):`, error);
    return { ok: false, retryable: false };
  }
}
