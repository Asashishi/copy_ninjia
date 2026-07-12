import type { Sticker, StickerSet } from "@grammyjs/types";
import { logger } from "./logger";
import { bot } from "./telegram";

/**
 * 「按情绪关键词挑一枚应景 emoji/贴纸」的公共积木：白名单贴纸包的拉取与
 * 缓存（getAllStickers，按 pack short name 调 getStickerSet）、文本关键词
 * 到候选 emoji 的匹配（matchCandidateEmojis）、均匀随机挑选（pickRandom）。
 * src/stickers.ts（回复贴纸）三样都用；src/reactions.ts（消息反应）只用
 * 后两样——它最终设的是标准 emoji 反应，不涉及贴纸包。
 */

/** 各包的贴纸集合缓存（进程内，重启即刷新——包内容本就极少变动）。 */
const stickerSetCache: Map<string, StickerSet> = new Map();
/** 已知拉取失败的包，避免每次触发都重复打一次必失败的请求。 */
const failedPacks: Set<string> = new Set();

async function getStickerSet(packName: string): Promise<StickerSet | null> {
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

export function pickRandom<T>(items: T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * 把一枚贴纸描述成 AI 对话缓存里的一行文本，带上模型能参考的元数据：
 * 贴纸的情绪 emoji 和所属贴纸包名。两者都可能缺失（无 emoji 的贴纸、
 * 不属于任何包的贴纸），按有什么写什么。群友发的贴纸和机器人自己发的
 * 贴纸都用这个格式记录。
 */
export function describeStickerForContext(sticker: { emoji?: string; set_name?: string }): string {
  const parts: string[] = [];
  if (sticker.emoji) parts.push(`情绪含义 ${sticker.emoji}`);
  if (sticker.set_name) parts.push(`来自贴纸包「${sticker.set_name}」`);
  return parts.length > 0 ? `（发了一枚贴纸：${parts.join("，")}）` : "（发了一枚贴纸）";
}
