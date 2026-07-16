import type { Sticker, StickerSet } from "@grammyjs/types";
import { logger } from "../infra/logger";
import { bot } from "../infra/telegram";
import { failedPacks, stickerSetCache } from "../cache/stickerSets";

/**
 * 贴纸领域的公共积木：白名单贴纸包的拉取与缓存（getAllStickers，按 pack
 * short name 调 getStickerSet）、文本关键词到候选 emoji 的匹配
 * （matchCandidateEmojis）、贴纸转描述行（describeStickerForContext）、
 * 挑选视觉解析素材来源（pickStickerVisionSource）。均匀随机挑选见
 * libs/random.ts 的 pickRandom（通用工具，不是贴纸领域专属，调用方直接从
 * 那里 import）。
 * src/ai/stickers.ts（回复贴纸挑选）、src/ai/stickerCatalog.ts（贴纸目录
 * 生成）都用；src/ai/reactions.ts（消息反应）只用 matchCandidateEmojis——
 * 它最终设的是标准 emoji 反应，不涉及贴纸包。
 */

/** 拉取（或复用缓存）单个包的贴纸集合；失败返回 null（而非空集合），供
 *  调用方区分「拉取失败」与「包确实没有贴纸」——见 ai/stickerCatalog.ts
 *  的 generatePackCatalog，剪枝逻辑必须能分辨这两种情况。 */
export async function getStickerSet(packName: string): Promise<StickerSet | null> {
  const cached: StickerSet | undefined = stickerSetCache.get(packName);
  if (cached) return cached;
  if (failedPacks.has(packName)) return null;

  try {
    const set: StickerSet = await bot.api.getStickerSet(packName);
    stickerSetCache.set(packName, set);
    return set;
  } catch (error: unknown) {
    logger.error(`Failed to fetch sticker set "${packName}":`, error);
    failedPacks.add(packName);
    return null;
  }
}

/** 并发拉取（或复用缓存）白名单里所有包，汇总成一个贴纸列表。 */
export async function getAllStickers(packs: string[]): Promise<Sticker[]> {
  const sets: (StickerSet | null)[] = await Promise.all(packs.map(getStickerSet));
  return sets.flatMap((set: StickerSet | null) => set?.stickers ?? []);
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
 * ai/stickerCatalog.ts 的目录条目键。
 */
export function pickStickerVisionSource(sticker: Sticker): { fileId: string; fileUniqueId: string } | null {
  const downloadFileId: string | undefined = !sticker.is_animated && !sticker.is_video ? sticker.file_id : sticker.thumbnail?.file_id;
  if (!downloadFileId) return null;
  return { fileId: downloadFileId, fileUniqueId: sticker.file_unique_id };
}

/** 根据文本命中的关键词，找出「应景」的候选 emoji 集合；未命中任何关键词则返回空集合。 */
export function matchCandidateEmojis(emotionKeywords: Record<string, string[]>, text: string): Set<string> {
  const candidates: Set<string> = new Set();
  for (const [emoji, keywords] of Object.entries(emotionKeywords)) {
    if (keywords.some((keyword: string) => text.includes(keyword))) {
      candidates.add(emoji);
    }
  }
  return candidates;
}

/**
 * 把一枚贴纸描述成 AI 对话缓存里的一行文本，带上模型能参考的元数据：
 * 贴纸的情绪 emoji 和所属贴纸包名，以及（若有）画面描述。三者都可能缺失
 * （无 emoji 的贴纸、不属于任何包的贴纸、没有目录/视觉解析结果的贴纸），
 * 按有什么写什么。群友发的贴纸和机器人自己发的贴纸都用这个格式记录。
 * @param visualDescription 画面描述（贴纸目录条目或视觉解析结果，见
 *   ai/stickerCatalog.ts、ai/imageDescription.ts 的 describeMedia）；没有则
 *   省略这部分，退化为原有的纯元数据行。
 */
export function describeStickerForContext(sticker: { emoji?: string; set_name?: string }, visualDescription?: string): string {
  const parts: string[] = [];
  if (visualDescription) parts.push(`画面：${visualDescription}`);
  if (sticker.emoji) parts.push(`情绪含义 ${sticker.emoji}`);
  if (sticker.set_name) parts.push(`来自贴纸包「${sticker.set_name}」`);
  return parts.length > 0 ? `（发了一枚贴纸：${parts.join("，")}）` : "（发了一枚贴纸）";
}
