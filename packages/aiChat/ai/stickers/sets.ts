import type { StickerSet } from "@grammyjs/types";
import { logger } from "../../../infra/logger";
import { telegramApi } from "../../../infra/telegram";
import { failedPacks, inflightStickerSets, stickerSetCache } from "../../../cache/workers/aiChat/stickers/sets";
import { STICKER_SET_FAILURE_RETRY_MS } from "../../../consts/aiChat/stickers";
import { invalidateStickerMenu } from "../../../cache/workers/aiChat/stickers/menu";

interface StickerSetApi {
  getStickerSet(packName: string): Promise<StickerSet>;
}

/**
 * 白名单贴纸包的拉取与缓存（getStickerSet，按 pack short name）。
 * packages/aiChat/ai/tools/stickers.ts（两层贴纸工具）、packages/aiChat/ai/stickers/catalog.ts（贴纸目录
 * 生成）都用。
 *
 * 本模块持有 AI 闲聊 Worker 独占的贴纸集合缓存，因此**只能在那条线程里
 * 加载**；主线程也要用的两个纯函数在 aiChat/ai/stickers/describe.ts，理由见该文件
 * 模块头注。
 */

/** 拉取（或复用缓存）单个包的贴纸集合；失败返回 null（而非空集合），供
 *  调用方区分「拉取失败」与「包确实没有贴纸」——见 aiChat/ai/stickers/catalog.ts
 *  的 generatePackCatalog，剪枝逻辑必须能分辨这两种情况。 */
export async function getStickerSet(packName: string, api: StickerSetApi = telegramApi): Promise<StickerSet | null> {
  const cached: StickerSet | undefined = stickerSetCache.get(packName);
  if (cached) return cached;
  const retryAt: number | undefined = failedPacks.get(packName);
  if (retryAt !== undefined) {
    if (Date.now() < retryAt) return null;
    failedPacks.delete(packName);
  }

  // 缓存未命中时把在途 Promise 也登记进缓存做请求合并（样式同
  // aiChat/ai/imageDescription.ts 的 describeMedia）：并发的几轮回复同时组装贴纸
  // 菜单时，同一个未缓存的包只对 Telegram 发一次请求。
  const inflight: Promise<StickerSet | null> | undefined = inflightStickerSets.get(packName);
  if (inflight) return inflight;

  const request: Promise<StickerSet | null> = (async (): Promise<StickerSet | null> => {
    try {
      const set: StickerSet = await api.getStickerSet(packName);
      stickerSetCache.set(packName, set);
      // 拉到一个此前拿不到的包会让贴纸菜单多出一项，记忆化的那份就旧了。
      invalidateStickerMenu();
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
