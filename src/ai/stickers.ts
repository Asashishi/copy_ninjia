import { readFileSync } from "node:fs";
import type { Sticker } from "@grammyjs/types";
import { logger } from "../infra/logger";
import { sendSticker } from "../infra/telegram";
import { describeStickerForContext, getAllStickers, matchCandidateEmojis } from "./stickerSets";
import { pickRandom } from "../libs/random";
import { STICKERS_CONFIG_PATH } from "../consts/paths";

/**
 * AI 回复贴纸包：每次 AI 回复（含随机搭话）后，有一定概率从白名单贴纸包里挑一枚
 * 「应景」的贴纸跟发。白名单、触发概率、情绪关键词映射都放在 config/stickers.json
 * 里，改配置不需要碰代码，且该文件不进 .gitignore（随仓库一起提交）。
 */

interface StickerConfig {
  /** AI 每次回复后，额外触发一次贴纸发送的概率（0~1）。 */
  replyStickerProbability: number;
  /** 贴纸包白名单，取值为 t.me/addstickers/<name> 里的 <name>（贴纸集合的 short name）。 */
  packs: string[];
  /** 情绪 -> 关键词：回复文本命中某个 emoji 下的任一关键词，就把该 emoji 记为候选，
   *  最终从白名单贴纸里挑一枚 emoji 命中候选集合的贴纸发送，做到「应景」。 */
  emotionKeywords: Record<string, string[]>;
}

const config: StickerConfig = JSON.parse(readFileSync(STICKERS_CONFIG_PATH, "utf8"));

/**
 * 按回复文本挑一枚「应景」的贴纸：优先在候选 emoji（见 matchCandidateEmojis）命中的
 * 贴纸里随机选一枚；没命中任何情绪关键词，或命中的 emoji 在白名单贴纸里都找不到，
 * 就退化为在全部白名单贴纸里随机选。贴纸包全部拉取失败时返回 null。
 */
async function pickSticker(contextText: string): Promise<Sticker | null> {
  const allStickers: Sticker[] = await getAllStickers(config.packs);
  if (allStickers.length === 0) return null;

  const candidateEmojis: Set<string> = matchCandidateEmojis(config.emotionKeywords, contextText);
  if (candidateEmojis.size > 0) {
    const matched: Sticker[] = allStickers.filter((sticker: Sticker) => sticker.emoji && candidateEmojis.has(sticker.emoji));
    const picked: Sticker | undefined = pickRandom(matched);
    if (picked) return picked;
  }

  return pickRandom(allStickers) ?? null;
}

/**
 * 以配置的概率（默认 1/2）触发一次贴纸发送：按 contextText 挑一枚应景的白名单贴纸
 * 发到目标聊天。fire-and-forget，不阻塞调用方；白名单为空、概率未命中或贴纸包
 * 拉取失败时静默跳过。
 * @param chatId 目标聊天 ID。
 * @param contextText 用于匹配情绪/挑选应景贴纸的文本（通常是本次 AI 回复的原文）。
 * @param onSent 贴纸确认发送成功后的回调，参数是这枚贴纸的上下文描述行
 *   （见 describeStickerForContext）与发出去那条消息的 ID——调用方用描述行
 *   把贴纸自录进 AI 对话缓存，用消息 ID 报回主线程登记自发消息（防频道
 *   自回环，见 infra/selfSentTracker.ts）。用回调而不是让本模块直接调
 *   aiChat 的 recordChatMessage，是为了避免 stickers.ts 和
 *   workers/aiChatWorker.ts 互相 import 形成循环依赖。
 */
export function maybeSendStickerReply(chatId: number, contextText: string, onSent?: (stickerDescription: string, messageId: number) => void): void {
  if (config.packs.length === 0) return;
  if (Math.random() >= config.replyStickerProbability) return;

  void (async (): Promise<void> => {
    const sticker: Sticker | null = await pickSticker(contextText);
    if (!sticker) return;
    const sentMessageId: number | undefined = await sendSticker(chatId, sticker.file_id);
    if (sentMessageId !== undefined && onSent) {
      onSent(describeStickerForContext(sticker), sentMessageId);
    }
  })().catch((error: unknown) => {
    logger.error("Error in sticker reply task:", error);
  });
}
