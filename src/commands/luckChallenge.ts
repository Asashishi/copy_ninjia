import type { Context } from "grammy";
import { InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import type { InlineQueryResultArticle } from "@grammyjs/types";
import { formatUserLabel } from "../users/userLabel";
import {
  FORTUNE_THUMBNAIL_URL,
  LUCK_TIERS,
  PROBABILITY_THUMBNAIL_URL,
  RATE_LIMIT_MAX_CALLS_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
} from "../consts/luckChallenge";
import { dailyLuckCache, luckCacheState, recentCallTimestamps } from "../cache/luckChallenge";
import type { LuckTier } from "../types";

/**
 * 抽今日运势，仅通过 Telegram 内联模式触发：在任意聊天框里
 * `@本机器人 [文本]`（不用真的把机器人拉进那个群），由
 * handleLuckChallengeInlineQuery（挂在 index.ts 的 inline_query 上）应答。
 * 用户选中的结果会以"该用户自己发的消息（通过 @本机器人）"形式发出——
 * 天然满足"只能测自己的"：谁选中结果，结算的就是谁自己的身份，别人没法
 * 替别人点。消息上附带的"我也试试"/"转发"是 switch_inline 按钮，点了只是
 * 帮旁观者原地重新弹出内联搜索（或换个聊天弹），并不会越权替对方测算。
 * 这个入口需要先在 BotFather 里给机器人开启 Inline Mode，代码这边控制
 * 不了那个开关。
 *
 * 「查看概率」（不带文本时的第二个结果）显示的不是一张固定给所有人看的
 * 总表，而是查询者今天实际抽到的那个吉凶档对应的行大运（大吉）/ 倒大霉
 * （大凶）概率里数字大的那一个——按档查表得出，该档定了这个数字就定了，
 * 同样"固定"；不重复显示吉凶本身（那是"未卜先知"结果的职责）。还没测过
 * 吉凶就顺带自动测一次（复用同一份缓存，不会跟后续单独测吉凶的结果对不上）。
 *
 * 带文本的查询（把文本当"所求事项"）只测吉凶，不算、也不显示概率。
 *
 * 运势结果按「用户 ID (+ 文本)」缓存，同一天同一把 key 只抽一次，抽到什么
 * 一天内都不会变；不带文本和带文本是两把不同的 key，互不影响。缓存只存在
 * 内存里，每天在东京时间零点自然过期（下一次请求触发清空），不落盘、重启
 * 即丢——这只是个图一乐的功能，没必要为它多写一个持久化文件。
 */

function getTokyoDateKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function ensureCacheFreshForToday(): void {
  const todayKey: string = getTokyoDateKey();
  if (todayKey !== luckCacheState.dayKey) {
    luckCacheState.dayKey = todayKey;
    dailyLuckCache.clear();
  }
}

function drawLuckTier(roll: number): LuckTier {
  let cumulative: number = 0;
  for (const tier of LUCK_TIERS) {
    cumulative += tier.weight;
    if (roll <= cumulative) return tier;
  }
  return LUCK_TIERS[LUCK_TIERS.length - 1]!;
}

function getOrDrawLuckTier(userId: number, text: string | undefined): LuckTier {
  ensureCacheFreshForToday();
  const cacheKey: string = text ? `${userId}:${text}` : String(userId);
  const cached: LuckTier | undefined = dailyLuckCache.get(cacheKey);
  if (cached) return cached;

  const tier: LuckTier = drawLuckTier(Math.floor(Math.random() * 100) + 1);
  dailyLuckCache.set(cacheKey, tier);
  return tier;
}

/** 由吉凶档查表得出行大运/倒大霉概率，取数字大的那一个（同档查出来的结果固定不变）。 */
function pickDominantProbability(tier: LuckTier): { label: string; percent: number } {
  const misfortunePercent: number = 100 - tier.fortunePercent;
  const isFortuneHigher: boolean = tier.fortunePercent >= misfortunePercent;
  return isFortuneHigher ? { label: "行大运", percent: tier.fortunePercent } : { label: "倒大霉", percent: misfortunePercent };
}

/** "我也试试"（原地重开一次内联搜索）+ 可选"同款问题"（原样复用同一段文本，
 * 方便别人测一模一样的所求事项）+ "转发"（挑一个聊天分享同一次内联搜索）。 */
function buildRetryKeyboard(text: string | undefined): InlineKeyboard {
  const keyboard: InlineKeyboard = new InlineKeyboard().switchInlineCurrent("我也试试", "");
  if (text) {
    const sameQuestionLabel: string = text.length > 20 ? `${text.slice(0, 20)}…` : text;
    keyboard.switchInlineCurrent(sameQuestionLabel, text);
  }
  keyboard.row().switchInline("转发", text ?? "");
  return keyboard;
}

function buildFortuneResult(tier: LuckTier, userLabel: string, text: string | undefined): InlineQueryResultArticle {
  const bodyText: string = text
    ? `你好，${userLabel}\n所求事项: ${text}\n结果: ${tier.label}\n${tier.comment}`
    : `你好，${userLabel}\n汝的今日运势: ${tier.label}\n${tier.comment}`;
  return InlineQueryResultBuilder.article(text ? "luck-fortune-text" : "luck-fortune", "未卜先知", {
    description: text ? `所求事项：${text}` : "测测你今天的运势",
    reply_markup: buildRetryKeyboard(text),
    thumbnail_url: FORTUNE_THUMBNAIL_URL,
  }).text(bodyText);
}

function buildProbabilityResult(tier: LuckTier, userLabel: string): InlineQueryResultArticle {
  const { label, percent } = pickDominantProbability(tier);
  return InlineQueryResultBuilder.article("luck-probability", "概率论！", {
    description: "看看你今天行大运/倒大霉的概率",
    reply_markup: buildRetryKeyboard(undefined),
    thumbnail_url: PROBABILITY_THUMBNAIL_URL,
  }).text(`你好，${userLabel}\n汝今天${label}概率是 ${percent}%`);
}

/** 全局频率限制（见 consts/luckChallenge.ts 的注释）：超限就不再往下算，
 * 回一条提示结果而不是留空——留空的话内联结果列表里什么都不显示，用户
 * 根本看不出是限流还是机器人挂了。 */
function tryConsumeRateLimit(): boolean {
  const now: number = Date.now();
  const cutoff: number = now - RATE_LIMIT_WINDOW_MS;
  while (recentCallTimestamps.length > 0 && recentCallTimestamps[0]! < cutoff) {
    recentCallTimestamps.shift();
  }
  if (recentCallTimestamps.length >= RATE_LIMIT_MAX_CALLS_PER_MINUTE) return false;
  recentCallTimestamps.push(now);
  return true;
}

/** 超过频率限制时的提示：标题/描述在结果列表里不用选中就能看到，选中了
 * 也只是把这句嘲讽发出去，不会触发任何抽签逻辑。 */
function buildRateLimitedResult(): InlineQueryResultArticle {
  return InlineQueryResultBuilder.article("luck-rate-limited", "太快啦，本天才应付不过来～", {
    description: "本天才每分钟最多接 30 次，杂鱼先歇会儿再来吧",
  }).text("笨蛋，问太快啦，本天才每分钟最多接 30 次，杂鱼先歇会儿再来吧♡");
}

/**
 * 处理内联查询（用户在任意聊天框里 `@本机器人 [文本]`）。不带文本时给出两个
 * 结果（未卜先知 / 概率论），带文本时只给一个（拿这段文本当所求事项测吉凶，
 * 不出概率）。查询者是谁就用谁的身份结算/缓存——选中结果后消息会以查询者
 * 本人的名义发出（带"通过 @本机器人"标注）。
 */
export async function handleLuckChallengeInlineQuery(ctx: Context): Promise<void> {
  const inlineQuery = ctx.inlineQuery;
  if (!inlineQuery) return;

  if (!tryConsumeRateLimit()) {
    await ctx.answerInlineQuery([buildRateLimitedResult()], { cache_time: 1, is_personal: true });
    return;
  }

  const fromUser = inlineQuery.from;
  const userLabel: string = formatUserLabel({ id: fromUser.id, username: fromUser.username, first_name: fromUser.first_name });
  const text: string = inlineQuery.query.trim();

  // 不带文本时"未卜先知"和"概率论"两个结果说的是同一份吉凶，这里只抽一次、
  // 两处复用，避免重复查表/重复经过每日缓存逻辑。
  const tier: LuckTier = getOrDrawLuckTier(fromUser.id, text || undefined);
  const results: InlineQueryResultArticle[] = text
    ? [buildFortuneResult(tier, userLabel, text)]
    : [buildFortuneResult(tier, userLabel, undefined), buildProbabilityResult(tier, userLabel)];

  await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
}
