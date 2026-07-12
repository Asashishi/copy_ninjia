import { readFileSync } from "node:fs";
import { logger } from "../infra/logger";
import { setMessageReaction } from "../infra/telegram";
import { matchCandidateEmojis, pickRandom } from "./stickerSets";
import { REACTIONS_CONFIG_PATH } from "../consts/paths";

/**
 * AI 回复消息反应：AI 回复（含随机搭话）触发时，有一定概率给触发这次回复的
 * 那条消息扣一个「应景」的标准 emoji 反应。触发概率、情绪关键词映射都放在
 * config/reactions.json 里，不进 .gitignore。
 * 注：最初想法是用 addemoji 自定义表情包当白名单反应，但实测 Bot API 不允许
 * bot 给消息新增一个消息上原本不存在的自定义表情反应（REACTION_INVALID，
 * 与是否有 Telegram Premium 无关，是 bot 账号的硬限制），因此改为标准 emoji
 * 反应——emoji 只能是 Telegram 文档里列出的固定反应表情集合（ReactionTypeEmoji），
 * emotionKeywords 的 key 必须落在这个集合里，否则同样会被 REACTION_INVALID 拒绝。
 */

interface ReactionConfig {
  /** AI 每次触发回复后，额外触发一次消息反应的概率（0~1）。 */
  reactionProbability: number;
  /** 情绪 -> 关键词：文本命中某个 emoji 下的任一关键词，就把该 emoji 记为候选，
   *  最终从候选（或全部 key）里挑一枚当反应，做到「应景」。 */
  emotionKeywords: Record<string, string[]>;
}

const config: ReactionConfig = JSON.parse(readFileSync(REACTIONS_CONFIG_PATH, "utf8"));
const allEmojis: string[] = Object.keys(config.emotionKeywords);

/**
 * 按上下文文本挑一枚「应景」的 emoji：优先在命中关键词的候选 emoji 里随机选
 * 一枚；没命中任何情绪关键词就退化为在全部配置的 emoji 里随机选。
 */
function pickEmoji(contextText: string): string | undefined {
  const candidates: Set<string> = matchCandidateEmojis(config.emotionKeywords, contextText);
  if (candidates.size > 0) {
    const picked: string | undefined = pickRandom([...candidates]);
    if (picked) return picked;
  }
  return pickRandom(allEmojis);
}

/**
 * 以配置的概率（默认 1/3）触发一次消息反应：按 contextText 挑一枚应景的标准
 * emoji，设为 messageId 这条消息上的反应。fire-and-forget，不阻塞调用方；
 * 配置为空或概率未命中时静默跳过。
 * @param chatId 目标聊天 ID。
 * @param messageId 要设置反应的消息 ID（即触发这次 AI 回复的原消息）。
 * @param contextText 用于匹配情绪/挑选应景 emoji 的文本（通常是本次 AI 回复的原文）。
 */
export function maybeAddReaction(chatId: number, messageId: number, contextText: string): void {
  if (allEmojis.length === 0) return;
  if (Math.random() >= config.reactionProbability) return;

  const emoji: string | undefined = pickEmoji(contextText);
  if (!emoji) return;

  void setMessageReaction(chatId, messageId, emoji).catch((error: unknown) => {
    logger.error("Error in reaction task:", error);
  });
}
