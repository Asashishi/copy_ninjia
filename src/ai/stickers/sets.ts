import type { Sticker, StickerSet } from "@grammyjs/types";
import { logger } from "../../infra/logger";
import { bot } from "../../infra/telegram";
import { failedPacks, inflightStickerSets, stickerSetCache } from "../../cache/stickers/sets";
import { STICKER_SET_FAILURE_RETRY_MS } from "../../consts/aiChat/stickers";
import type { TelegramVisionSource } from "../../types/media";

interface StickerSetApi {
  getStickerSet(packName: string): Promise<StickerSet>;
}

/**
 * 贴纸领域的公共积木：白名单贴纸包的拉取与缓存（getStickerSet，按 pack
 * short name）、贴纸转描述行（describeStickerForContext）、挑选视觉解析
 * 素材来源（pickStickerVisionSource）。
 * src/ai/tools/stickers.ts（两层贴纸工具）、src/ai/stickers/catalog.ts（贴纸目录
 * 生成）都用。
 */

/** 拉取（或复用缓存）单个包的贴纸集合；失败返回 null（而非空集合），供
 *  调用方区分「拉取失败」与「包确实没有贴纸」——见 ai/stickers/catalog.ts
 *  的 generatePackCatalog，剪枝逻辑必须能分辨这两种情况。 */
export async function getStickerSet(packName: string, api: StickerSetApi = bot.api): Promise<StickerSet | null> {
  const cached: StickerSet | undefined = stickerSetCache.get(packName);
  if (cached) return cached;
  const retryAt: number | undefined = failedPacks.get(packName);
  if (retryAt !== undefined) {
    if (Date.now() < retryAt) return null;
    failedPacks.delete(packName);
  }

  // 缓存未命中时把在途 Promise 也登记进缓存做请求合并（样式同
  // ai/imageDescription.ts 的 describeMedia）：并发的几轮回复同时组装贴纸
  // 菜单时，同一个未缓存的包只对 Telegram 发一次请求。
  const inflight: Promise<StickerSet | null> | undefined = inflightStickerSets.get(packName);
  if (inflight) return inflight;

  const request: Promise<StickerSet | null> = (async (): Promise<StickerSet | null> => {
    try {
      const set: StickerSet = await api.getStickerSet(packName);
      stickerSetCache.set(packName, set);
      failedPacks.delete(packName);
      return set;
    } catch (error: unknown) {
      logger.error(`Failed to fetch sticker set "${packName}":`, error);
      failedPacks.set(packName, Date.now() + STICKER_SET_FAILURE_RETRY_MS);
      return null;
    } finally {
      inflightStickerSets.delete(packName);
    }
  })();
  inflightStickerSets.set(packName, request);
  return request;
}

/**
 * 选出一枚贴纸用于视觉解析的下载素材：静态贴纸（is_animated/is_video 均为
 * false）本体就是 webp 图片，直接下载；动态贴纸（tgs，Lottie 矢量动画）和
 * 视频贴纸（webm）都没有能直接喂视觉模型的静态画面，本项目也没有解码
 * 能力，改用 Telegram 自带的缩略图（webp 或 jpg）代替；两者都没有则放弃
 * 视觉解析，返回 null。
 *
 * 返回的 fileUniqueId 恒为贴纸自身的 file_unique_id（贴纸的身份），与实际
 * 下载来源（本体或缩略图）解耦——保证同一枚贴纸无论走哪条素材来源，描述
 * 都记在同一个缓存/目录键下，见 ai/imageDescription.ts 的 describeMedia、
 * ai/stickers/catalog.ts 的目录条目键。
 */
export function pickStickerVisionSource(sticker: Sticker): TelegramVisionSource | null {
  const source = !sticker.is_animated && !sticker.is_video ? sticker : sticker.thumbnail;
  if (!source) return null;
  return {
    fileId: source.file_id,
    fileUniqueId: sticker.file_unique_id,
    width: source.width,
    height: source.height,
  };
}

/**
 * 把一枚贴纸描述成 AI 对话缓存里的一行文本，带上模型能参考的元数据：
 * 贴纸的情绪 emoji 和所属贴纸包名，以及（若有）画面描述。三者都可能缺失
 * （无 emoji 的贴纸、不属于任何包的贴纸、没有目录/视觉解析结果的贴纸），
 * 按有什么写什么。群友发的贴纸和机器人自己发的贴纸都用这个格式记录。
 * @param visualDescription 画面描述（贴纸目录条目或视觉解析结果，见
 *   ai/stickers/catalog.ts、ai/imageDescription.ts 的 describeMedia）；没有则
 *   省略这部分，退化为原有的纯元数据行。
 */
export function describeStickerForContext(sticker: { emoji?: string; set_name?: string }, visualDescription?: string): string {
  const parts: string[] = [];
  if (visualDescription) parts.push(`画面：${visualDescription}`);
  if (sticker.emoji) parts.push(`情绪含义 ${sticker.emoji}`);
  if (sticker.set_name) parts.push(`来自贴纸包「${sticker.set_name}」`);
  return parts.length > 0 ? `（发了一枚贴纸：${parts.join("，")}）` : "（发了一枚贴纸）";
}
