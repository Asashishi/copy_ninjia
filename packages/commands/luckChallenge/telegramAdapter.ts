import type { InlineQueryResultArticle, ChosenInlineResult, InlineQuery, User } from "grammy/types";
import type { Context } from "grammy";
import { telegramSignal } from "../../libs/telegramSignal";
import { chatAtmosphere } from "../../infra/atmosphere";
import { formatUserLabel } from "../../users/userLabel";
import type { LuckDraw } from "../../types/luckChallenge";
import { LUCK_INLINE_NO_DRAW_CACHE_SECONDS, LUCK_RESULT_IDS } from "../../consts/luckChallenge";
import { recordInlineResultSources } from "../../infra/inlineResultSources";
import { logApiError } from "../../infra/telegram";
import { isTelegramRequestRejected } from "../../infra/telegram/errors";
import { logger } from "../../infra/logger";
import {
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../../infra/updateContext";
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
  const chosen: ChosenInlineResult | undefined = ctx.chosenInlineResult;
  if (!chosen || !LUCK_RESULT_IDS.has(chosen.result_id)) return;
  try {
    await ensureLuckCacheFreshForToday();
  } catch (error: unknown) {
    logger.error("Failed to refresh luck cache for chosen inline result:", error);
    return;
  }

  const text: string = chosen.query.trim();
  const cacheKey: string = luckCacheKey(
    chosen.from.id,
    chosen.result_id === "luck-fortune-text" ? text || undefined : undefined
  );
  promotePendingDraw(cacheKey);
}

/**
 * 不抽签时的应答（限流占位或空结果），客户端缓存 LUCK_INLINE_NO_DRAW_CACHE_SECONDS 秒；应答失败只记 API 错误，
 * update 取消照常上抛。
 * @param action 应答失败时日志里的动作名。
 */
async function answerLuckInlineQueryWithoutDraw(
  ctx: Context,
  results: InlineQueryResultArticle[],
  action: string
): Promise<void> {
  try {
    await ctx.answerInlineQuery(
      results,
      { cache_time: LUCK_INLINE_NO_DRAW_CACHE_SECONDS, is_personal: true },
      telegramSignal(currentUpdateAbortSignal())
    );
  } catch (error: unknown) {
    throwIfUpdateAborted();
    logApiError(action, error);
  }
}

/**
 * Telegram 内联查询适配层：负责输入输出，抽签、缓存与渲染由各领域模块完成。限流时应答占位结果；
 * 当天密钥刷新失败时记错误并应答空结果，面板不等到超时。
 */
export async function handleLuckChallengeInlineQuery(ctx: Context): Promise<void> {
  const inlineQuery: InlineQuery | undefined = ctx.inlineQuery;
  if (!inlineQuery) return;

  if (!tryConsumeLuckRateLimit()) {
    await answerLuckInlineQueryWithoutDraw(ctx, [buildRateLimitedResult()], "answer rate-limited luck inline query");
    return;
  }

  try {
    await ensureLuckCacheFreshForToday();
  } catch (error: unknown) {
    logger.error("Failed to refresh luck cache for inline query:", error);
    await answerLuckInlineQueryWithoutDraw(ctx, [], "answer luck inline query after cache refresh failure");
    return;
  }
  const fromUser: User = inlineQuery.from;
  // inline 查询没有目标群上下文，与群通知同用本进程生效的文案风格。
  const userLabel: string = formatUserLabel({
    id: fromUser.id,
    username: fromUser.username,
    first_name: fromUser.first_name,
  }, chatAtmosphere());
  const text: string = inlineQuery.query.trim();
  const cacheKey: string = luckCacheKey(fromUser.id, text || undefined);
  const draw: LuckDraw = getOrDrawLuck(cacheKey);
  const results: InlineQueryResultArticle[] = text
    ? [buildFortuneResult({ draw, userId: fromUser.id, userLabel, text })]
    : [
      buildFortuneResult({ draw, userId: fromUser.id, userLabel, text: undefined }),
      buildProbabilityResult(draw, fromUser.id, userLabel),
    ];
  try {
    await ctx.answerInlineQuery(
      results,
      { cache_time: 0, is_personal: true },
      telegramSignal(currentUpdateAbortSignal())
    );
  } catch (error: unknown) {
    throwIfUpdateAborted();
    logApiError("answer luck inline query", error);
    if (isTelegramRequestRejected(error)) return;
  }
  // 登记所求事项作为结果正文对应的源文本，广告检测按结果正文取回
  // （见 infra/inlineResultSources.ts）；`text` 为空时不登记，纯运势与概率结果不进判定。
  recordInlineResultSources(fromUser.id, text, results);
}
