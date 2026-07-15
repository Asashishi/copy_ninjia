/**
 * 群聊图片的异步描述：下载 Telegram 图片文件，喂给 grok 的视觉输入，产出
 * 一行简短中文描述，供 workers/aiChatWorker.ts 的 recordChatImage 把对话
 * 缓存里的占位文本替换掉。跑在 AI Worker 线程里（调用方就是它）。
 *
 * 失败一律返回 null、绝不抛错——调用方拿 null 把占位回退成纯「[图片]」，
 * 转录里至少留下"这里有一张图"的痕迹，AI 流水线不因一张图挂掉。
 */

import { logger } from "../infra/logger";
import { bot, buildFileDownloadUrl } from "../infra/telegram";
import { extractOutputText, requestXaiResponse } from "./xai";
import { sanitizeInline, truncateInline } from "../libs/text";
import {
  IMAGE_DESCRIPTION_CACHE_MAX,
  IMAGE_DESCRIPTION_MAX_CHARS,
  IMAGE_DESCRIPTION_MAX_TOKENS,
  IMAGE_DESCRIPTION_PROMPT,
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  IMAGE_MAX_DOWNLOAD_BYTES,
  XAI_MODEL,
} from "../consts/aiChat";

/**
 * 图片描述缓存：按 file_unique_id 去重。同一张图片无论被谁、在哪个聊天、
 * 重发多少次，Telegram 给的 file_id 都可能不同，但 file_unique_id 恒定——
 * 不用自己下载算 hash，Telegram 已经替我们算好了（file_unique_id 不能用于
 * 下载，所以下载仍要 file_id）。值存 Promise 而不是结果：同一张图短时间被
 * 刷屏时，第二条起直接挂在首条的在途解析上，连并发的重复下载/API 调用也
 * 合并掉。解析失败（resolve 为 null）就把条目摘掉，下次这张图重发时重试，
 * 不把一次偶发失败钉死成永久失败。
 */
const descriptionCache: Map<string, Promise<string | null>> = new Map();

/**
 * 下载并描述一张图片（带 file_unique_id 去重缓存，见 descriptionCache）。
 * @param fileId Telegram 的图片 file_id（调用方已按大小挑好档位，见
 *   auto/message.ts 的 pickPhotoFile）。
 * @param fileUniqueId 同一档位的 file_unique_id，缓存键。
 * @returns 压成单行、截断后的中文描述；下载/解析任一步失败则 null。
 */
export function describeImage(fileId: string, fileUniqueId: string): Promise<string | null> {
  const cached: Promise<string | null> | undefined = descriptionCache.get(fileUniqueId);
  if (cached) return cached;

  const pending: Promise<string | null> = describeImageUncached(fileId).then((description: string | null) => {
    if (description === null) descriptionCache.delete(fileUniqueId);
    return description;
  });
  descriptionCache.set(fileUniqueId, pending);
  // 超上限就淘汰最早插入的条目（Map 迭代顺序即插入顺序），不搞真 LRU——
  // 热图重发不刷新位置，靠上限本身足够大兜底。
  if (descriptionCache.size > IMAGE_DESCRIPTION_CACHE_MAX) {
    descriptionCache.delete(descriptionCache.keys().next().value!);
  }
  return pending;
}

async function describeImageUncached(fileId: string): Promise<string | null> {
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      logger.error(`getFile for chat image ${fileId} returned no file_path`);
      return null;
    }
    // 只记录 file_path，绝不能把完整下载 URL 打进日志——URL 里嵌着 bot token
    // （见 infra/telegram.ts 的 buildFileDownloadUrl 注释）。
    const res: Response = await fetch(buildFileDownloadUrl(file.file_path), {
      signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.error(`Failed to download chat image (${res.status}): ${file.file_path}`);
      return null;
    }
    const bytes: ArrayBuffer = await res.arrayBuffer();
    if (bytes.byteLength > IMAGE_MAX_DOWNLOAD_BYTES) {
      // pickPhotoFile 已按 file_size 预筛过，走到这里说明元数据缺失或不实。
      logger.error(`Chat image too large to describe (${bytes.byteLength} bytes): ${file.file_path}`);
      return null;
    }
    // Telegram 的 photo 统一是 jpeg；按扩展名兜一手 png，其余按 jpeg 报。
    const mime: string = file.file_path.endsWith(".png") ? "image/png" : "image/jpeg";
    const dataUri: string = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

    const data: any = await requestXaiResponse(
      {
        model: XAI_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_image", image_url: dataUri, detail: "high" },
              { type: "input_text", text: IMAGE_DESCRIPTION_PROMPT },
            ],
          },
        ],
        max_output_tokens: IMAGE_DESCRIPTION_MAX_TOKENS,
      },
      "xAI image understanding API"
    );
    if (!data) return null;
    const description: string = sanitizeInline(extractOutputText(data));
    if (!description) return null;
    return truncateInline(description, IMAGE_DESCRIPTION_MAX_CHARS);
  } catch (error: unknown) {
    logger.error("Error describing chat image:", error);
    return null;
  }
}
