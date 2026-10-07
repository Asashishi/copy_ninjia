import type { Sticker, PhotoSize } from "grammy/types";
import { stickerSentTagTemplate } from "../../../consts/aiChat/prompts/transcript";
import type { TelegramVisionSource } from "../../../types/media";

/**
 * 贴纸的两个纯函数：挑选视觉解析素材来源（pickStickerVisionSource）与把贴纸
 * 转成对话缓存里的一行文本（describeStickerForContext）。
 *
 * 本模块是不碰任何缓存的叶子模块：两个函数由主线程的消息流水线
 * （auto/message/sticker.ts、auto/message/text.ts）在把贴纸投给 AI Worker 之前调用；
 * AI Worker 独占的贴纸集合缓存（cache/workers/aiChat/stickers/sets.ts）由
 * aiChat/ai/stickers/sets.ts 持有。
 */

/**
 * 选出一枚贴纸用于视觉解析的下载素材：静态贴纸（is_animated/is_video 均为
 * false）下载本体；动态贴纸（tgs）和视频贴纸（webm）改用 Telegram 自带的缩略图；
 * 两者都没有则返回 null。
 *
 * 返回的 fileUniqueId 恒为贴纸自身的 file_unique_id，与实际下载来源（本体或缩略图）
 * 无关，同一枚贴纸的描述记在同一个缓存/目录键下，见 aiChat/ai/imageDescription.ts 的
 * describeMedia、aiChat/ai/stickers/catalog.ts 的目录条目键。
 */
export function pickStickerVisionSource(sticker: Sticker): TelegramVisionSource | null {
  const source: PhotoSize | undefined = !sticker.is_animated && !sticker.is_video ? sticker : sticker.thumbnail;
  if (!source) return null;
  return {
    fileId: source.file_id,
    fileUniqueId: sticker.file_unique_id,
    width: source.width,
    height: source.height,
  };
}

/** describeStickerForContext 读取的贴纸元数据；两项都可能缺失。 */
export interface DescribeStickerForContextParams {
  /** 贴纸的情绪 emoji。 */
  emoji?: string;
  /** 所属贴纸包名。 */
  set_name?: string;
}

/**
 * 把一枚贴纸描述成 AI 对话缓存里的一行文本：画面描述（若有）、情绪 emoji 与所属贴纸包名，
 * 缺哪项省哪项。群友发的贴纸和机器人自己发的贴纸都用这个格式记录。
 * @param visualDescription 画面描述（贴纸目录条目或视觉解析结果，见
 *   aiChat/ai/stickers/catalog.ts、aiChat/ai/imageDescription.ts 的 describeMedia）；没有则
 *   省略这部分，只写元数据。
 */
export function describeStickerForContext(sticker: DescribeStickerForContextParams, visualDescription?: string): string {
  const parts: string[] = [];
  if (visualDescription) parts.push(`画面：${visualDescription}`);
  if (sticker.emoji) parts.push(`情绪含义 ${sticker.emoji}`);
  if (sticker.set_name) parts.push(`来自贴纸包「${sticker.set_name}」`);
  return stickerSentTagTemplate(parts.join("，"));
}
