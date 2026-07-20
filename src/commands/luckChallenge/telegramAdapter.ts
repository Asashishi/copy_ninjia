import type { InlineQueryResultArticle } from "@grammyjs/types";
import type { Context } from "grammy";
import { formatUserLabel } from "../../users/userLabel";
import type { LuckDraw } from "../../types/luckChallenge";
import { LUCK_RESULT_IDS } from "../../consts/luckChallenge";
import {
  ensureLuckCacheFreshForToday,
  getOrDrawLuck,
  promotePendingDraw,
} from "./cache";
import { luckCacheKey } from "./key";
import { tryConsumeLuckRateLimit } from "./rateLimit";
import {
  buildFortuneResult,
  buildProbabilityResult,
  buildRateLimitedResult,
} from "./rendering";

/** Telegram chosen_inline_result 是抽签真正被选中的主确认信号。 */
export async function handleLuckChosenInlineResult(ctx: Context): Promise<void> {
  const chosen = ctx.chosenInlineResult;
  if (!chosen || !LUCK_RESULT_IDS.has(chosen.result_id)) return;
  await ensureLuckCacheFreshForToday();

  const text: string = chosen.query.trim();
  const cacheKey: string = luckCacheKey(
    chosen.from.id,
    chosen.result_id === "luck-fortune-text" ? text || undefined : undefined
  );
  promotePendingDraw(cacheKey);
}

/** Telegram 内联查询适配层：负责输入输出，抽签、缓存与渲染由各领域模块完成。 */
export async function handleLuckChallengeInlineQuery(ctx: Context): Promise<void> {
  const inlineQuery = ctx.inlineQuery;
  if (!inlineQuery) return;

  if (!tryConsumeLuckRateLimit()) {
    await ctx.answerInlineQuery([buildRateLimitedResult()], { cache_time: 1, is_personal: true });
    return;
  }

  await ensureLuckCacheFreshForToday();
  const fromUser = inlineQuery.from;
  const userLabel: string = formatUserLabel({
    id: fromUser.id,
    username: fromUser.username,
    first_name: fromUser.first_name,
  });
  const text: string = inlineQuery.query.trim();
  const cacheKey: string = luckCacheKey(fromUser.id, text || undefined);
  const draw: LuckDraw = getOrDrawLuck(cacheKey);
  const results: InlineQueryResultArticle[] = text
    ? [buildFortuneResult({ draw, userId: fromUser.id, userLabel, text })]
    : [
      buildFortuneResult({ draw, userId: fromUser.id, userLabel, text: undefined }),
      buildProbabilityResult(draw, fromUser.id, userLabel),
    ];

  await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
}
