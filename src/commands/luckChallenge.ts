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
  SAME_QUESTION_LABEL_MAX_LEN,
} from "../consts/luckChallenge";
import { dailyLuckCache, luckCacheState, pendingLuckDraws, pendingLuckRenderIndex, recentCallTimestamps } from "../cache/luckChallenge";
import { logger } from "../infra/logger";
import { onDiskIORespawn, postDiskIO } from "../infra/diskIO";
import { getTokyoDateKey } from "../libs/time";
import type { LuckDayCache, LuckDraw, LuckTier } from "../types";

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
 * （大凶）概率里数字大的那一个——具体数值不再是查表就得的定值，而是抽签时
 * 在该档的 fortunePercentRange 区间内浮动出的随机值（两位小数，见
 * rollFortunePercent），但一旦抽出就连同吉凶档一起进日缓存，同一天同一把
 * key 无论重复查询多少次，看到的都是同一个数；不重复显示吉凶本身（那是
 * "未卜先知"结果的职责）。还没测过吉凶就顺带自动测一次（复用同一份缓存，
 * 不会跟后续单独测吉凶的结果对不上）。
 *
 * 带文本的查询（把文本当"所求事项"）只测吉凶，不算、也不显示概率。
 *
 * 运势结果按「用户 ID (+ 文本)」缓存，同一天同一把 key 只抽一次，抽到什么
 * 一天内都不会变；不带文本和带文本是两把不同的 key，互不影响。缓存活在
 * 主线程内存里，每天在东京时间零点自然过期（下一次请求触发清空）。
 *
 * inline_query 只是"预览"——Telegram 在用户打字过程中会持续推送 inline_query
 * （每敲一下都可能触发一次），用户可能压根没打算测运势、只是消息恰好以
 * @本机器人 开头（比如单纯想 @ 机器人说句话），或者打到一半改主意删掉了。
 * 所以 getOrDrawLuck 在这里抽到的结果只进 pendingLuckDraws（见
 * cache/luckChallenge.ts），不落盘、也不算"今天测过"；真正被用户选中后才
 * 转正写入 dailyLuckCache 并经 postDiskIO 转投 diskIOWorker 落盘
 * （memory/luck/YYYY-MM-DD.json，按东京日期一个文件、只留当天，落盘机制
 * 与日志同一套按位置追加/截断修复，见 workers/diskIO/luckFiles.ts），重启
 * 后由 restoreLuckCache 灌回，当天结果不因重启改变；过期文件在写入时发现
 * 跨天就删。
 *
 * 「被选中」的确认信号有两路，命中任意一路即转正（幂等，重复到达无害）：
 * - chosen_inline_result 更新（主路，见 handleLuckChosenInlineResult）：
 *   用户选中结果时 Telegram 直接推给机器人，带真实 uid 和查询词，与结果
 *   发到哪个聊天无关——机器人不在场的群/私聊里抽的签也能确认落盘。需要
 *   在 BotFather 用 /setinlinefeedback 开启（建议 100%），否则收不到。
 * - 结果消息现身（兜底，挂在 index.ts 的 isInit 网关之前，见
 *   confirmLuckDraw）：机器人在任何聊天里（含未 /init 的群、机器人自己的
 *   私聊）看见文本恰好是某把待确认抽签渲染原文的消息就认领——不要求
 *   via_bot，转发副本也算数；靠渲染文本认领（马甲/匿名身份发出的消息
 *   from 不是真人，带不回 uid，转发副本的 from 更是转发者本人）。
 */

function ensureCacheFreshForToday(): void {
  const todayKey: string = getTokyoDateKey();
  if (todayKey !== luckCacheState.dayKey) {
    luckCacheState.dayKey = todayKey;
    dailyLuckCache.clear();
    pendingLuckDraws.clear();
    pendingLuckRenderIndex.clear();
  }
}

/** 抽签结果的缓存 key：带文本时按「用户 ID:文本」区分所求事项，不带文本时
 * 就是纯用户 ID（当天的默认运势）。dailyLuckCache/pendingLuckDraws 共用这一
 * 套 key 规则，抽出来单独提取避免两处各写一份、改一处忘了另一处。 */
function luckCacheKey(userId: number, text: string | undefined): string {
  return text ? `${userId}:${text}` : String(userId);
}

function drawLuckTier(roll: number): LuckTier {
  let cumulative: number = 0;
  for (const tier of LUCK_TIERS) {
    cumulative += tier.weight;
    if (roll <= cumulative) return tier;
  }
  return LUCK_TIERS[LUCK_TIERS.length - 1]!;
}

/** 在 tier.fortunePercentRange [min, max] 内均匀浮动出本次抽签的行大运具体
 * 数值（%），保留两位小数；只在抽到新结果时滚动一次，随 tier 一起先进
 * pendingLuckDraws、确认后再进日缓存/落盘（见 LuckDraw、getOrDrawLuck、
 * confirmLuckDraw），同一天同一 key 之后重复查询取到的都是这同一个数，
 * 不会每次查询都重新浮动。 */
function rollFortunePercent([min, max]: [number, number]): number {
  const raw: number = min + Math.random() * (max - min);
  return Math.round(raw * 100) / 100;
}

/** 预览阶段取（或抽）一次结果：优先复用已确认的 dailyLuckCache，其次复用
 * 还没确认的 pendingLuckDraws（同一天重复打字预览同一把 key 时看到的数字
 * 保持一致，不会每敲一次键就重新滚一次），都没有才真的抽一把——但只存进
 * pendingLuckDraws，不算"今天测过"。是否转正见 confirmLuckDraw。 */
function getOrDrawLuck(userId: number, text: string | undefined): LuckDraw {
  ensureCacheFreshForToday();
  const cacheKey: string = luckCacheKey(userId, text);
  const confirmed: LuckDraw | undefined = dailyLuckCache.get(cacheKey);
  if (confirmed) return confirmed;
  const pending: LuckDraw | undefined = pendingLuckDraws.get(cacheKey);
  if (pending) return pending;

  const tier: LuckTier = drawLuckTier(Math.floor(Math.random() * 100) + 1);
  const fortunePercent: number = rollFortunePercent(tier.fortunePercentRange);
  const draw: LuckDraw = { tier, fortunePercent };
  pendingLuckDraws.set(cacheKey, draw);
  return draw;
}

/** 登记"这段渲染出的消息原文，对应哪一把抽签 key"，供 confirmLuckDraw 反查。
 * 索引只按文本、不掺 userId——马甲/匿名身份发出的 via_bot 消息带不回真实
 * uid，理由见 cache/luckChallenge.ts 的 pendingLuckRenderIndex 注释。
 * 每次预览（哪怕命中缓存）都会重新登记一遍，重复登记同一对 key/文本是
 * 廉价的幂等覆盖，不需要额外去重。已经转正的 key 不再登记——没有必要，
 * confirmLuckDraw 对已转正的 key 本来就是空操作，省一次 Map 写入。 */
function registerPendingRendering(cacheKey: string, renderedText: string): void {
  if (dailyLuckCache.has(cacheKey)) return;
  pendingLuckRenderIndex.set(renderedText, cacheKey);
}

/**
 * 把一把待确认的抽签转正：pendingLuckDraws -> dailyLuckCache -> postDiskIO
 * 落盘。两路确认信号（chosen_inline_result / 文本认领）共用；幂等，
 * 已转正或查无 pending（消息不是运势结果、或进程恰好在预览和选中之间重启
 * 导致内存态丢失）都什么都不做——宁可当天该 key 之后被重新抽一次，也不要
 * 凭空落盘一条用户从未真正确认过的记录。
 */
function promotePendingDraw(cacheKey: string): void {
  const draw: LuckDraw | undefined = pendingLuckDraws.get(cacheKey);
  pendingLuckDraws.delete(cacheKey);
  if (!draw || dailyLuckCache.has(cacheKey)) return;

  dailyLuckCache.set(cacheKey, draw);
  // day 用刚校准过的 luckCacheState.dayKey，与本次缓存写入用的是同一个"今天"。
  postDiskIO({ type: "luckDraw", day: luckCacheState.dayKey, key: cacheKey, label: draw.tier.label, fortunePercent: draw.fortunePercent });
}

/**
 * 确认主路：chosen_inline_result 更新（挂在 index.ts 的 chosen_inline_result
 * 上）。用户在任何聊天里选中内联结果，Telegram 都会把这个更新直接推给
 * 机器人——带选中者的真实 uid、result_id 和查询词，不依赖机器人在那个
 * 聊天里收得到消息，也没有马甲身份的问题（选择动作永远来自真人账号）。
 * cacheKey 直接由 uid + 查询词重建，与预览侧 getOrDrawLuck 的口径一致。
 * 前提：BotFather 里 /setinlinefeedback 已开启，否则 Telegram 根本不发这
 * 类更新（此时只剩 via_bot 兜底路，见模块头注释）。
 */
export function handleLuckChosenInlineResult(ctx: Context): void {
  const chosen = ctx.chosenInlineResult;
  if (!chosen) return;
  // 限流提示不是抽签结果，选中它不该在今日缓存里占坑。
  if (chosen.result_id === "luck-rate-limited") return;
  ensureCacheFreshForToday();

  const text: string = chosen.query.trim();
  // 「未卜先知」带文本时按「所求事项」区分 key；「概率论」只在无文本时提供，
  // 与无文本的「未卜先知」共用同一把 key（同一份吉凶），口径同 luckCacheKey。
  const cacheKey: string = luckCacheKey(chosen.from.id, chosen.result_id === "luck-fortune-text" ? text || undefined : undefined);
  promotePendingDraw(cacheKey);
}

/**
 * 确认兜底路：机器人看得见的任何消息（index.ts 在 isInit 网关之前对每条
 * 更新调用本函数，含未 /init 群和私聊里的转发副本）用原文反查
 * pendingLuckRenderIndex 找到对应的 cacheKey。只认文本、不看消息的 from
 * ——用户以频道马甲/匿名管理员身份发出时 from 已被 Telegram 换成马甲，
 * 不含真实 uid（见 pendingLuckRenderIndex 注释）；转发副本的 from 是转发
 * 者本人，更不能信。渲染原文只有在结果真的被发出去之后才可能被人看到并
 * 原样出现（内联预览列表不展示正文），所以「文本对得上」本身就是「确实
 * 发出去了」的凭据；身份结算依然以 inline 侧登记的 cacheKey（真实 uid）
 * 为准，「只能测自己的」语义不变。
 */
export function confirmLuckDraw(messageText: string | undefined): void {
  if (typeof messageText !== "string") return;
  ensureCacheFreshForToday();

  const cacheKey: string | undefined = pendingLuckRenderIndex.get(messageText);
  if (!cacheKey) return;
  pendingLuckRenderIndex.delete(messageText);
  promotePendingDraw(cacheKey);
}

// diskIOWorker 崩溃重建后，把当天缓存整份重发给它：dailyLuckCache 本来就
// 活在主线程，不需要另设镜像，直接拿它当重放源即可（见 infra/diskIO.ts
// 的 onDiskIORespawn 注释）。先校准一次「今天」：这份镜像只在真的有请求
// 进来时才会惰性刷新（见 ensureCacheFreshForToday），若崩溃恰好发生在
// 跨天之后、当天第一次请求之前，镜像里可能还留着昨天的 dayKey/条目——
// 不校准就会把过期数据当成"今天"重发给新实例，污染它刚从磁盘正确恢复出
// 的今天状态。
onDiskIORespawn(() => {
  ensureCacheFreshForToday();
  if (dailyLuckCache.size === 0) return;
  for (const [key, draw] of dailyLuckCache) {
    postDiskIO({ type: "luckDraw", day: luckCacheState.dayKey, key, label: draw.tier.label, fortunePercent: draw.fortunePercent });
  }
});

/**
 * 启动时接管 diskIOWorker load 回执里的当日运势缓存。day 与今天（东京时区）
 * 不一致就整体丢弃——只在东京日期跨天在诊断窗口内发生时才会出现，此时
 * 这份缓存已经是昨天的，没有接管的价值。按 LUCK_TIERS 反查 label 还原成
 * LuckTier 对象，查不到（未来改了档位表）就丢弃该条并记日志，让用户当天
 * 重抽，不硬造对象；fortunePercent 原样带回、不重新滚动，但要落在该 tier
 * 当前的 fortunePercentRange 内才收——区间若也在这之间被改过，落盘的旧值
 * 可能已经不在新区间里，同样丢弃该条记日志，语义与 label 查不到时一致。
 * 必须在 runner 开始投喂 inline_query 之前调用（见 index.ts），否则会出现
 * 「今天已抽过却又抽出新结果」。
 */
export function restoreLuckCache(loaded: LuckDayCache | null): void {
  if (!loaded) return;
  const todayKey: string = getTokyoDateKey();
  if (loaded.day !== todayKey) return;

  luckCacheState.dayKey = todayKey;
  for (const [key, record] of loaded.entries) {
    const tier: LuckTier | undefined = LUCK_TIERS.find((t) => t.label === record.label);
    if (!tier) {
      logger.error(`Restored luck entry "${key}" has label "${record.label}" that no longer matches any LUCK_TIERS entry; dropping it, the user will redraw today.`);
      continue;
    }
    const [min, max] = tier.fortunePercentRange;
    if (record.fortunePercent < min || record.fortunePercent > max) {
      logger.error(`Restored luck entry "${key}" has fortunePercent ${record.fortunePercent} outside tier "${record.label}"'s current range [${min}, ${max}]; dropping it, the user will redraw today.`);
      continue;
    }
    dailyLuckCache.set(key, { tier, fortunePercent: record.fortunePercent });
  }
}

/** 取行大运/倒大霉里数字大的那个，语义见 LuckDraw.fortunePercent。100 减法后
 * 重新四舍五入到两位小数，避免浮点减法在两位小数上产生的尾数误差。 */
function pickDominantProbability(draw: LuckDraw): { label: string; percent: number } {
  const misfortunePercent: number = Math.round((100 - draw.fortunePercent) * 100) / 100;
  const isFortuneHigher: boolean = draw.fortunePercent >= misfortunePercent;
  return isFortuneHigher ? { label: "行大运", percent: draw.fortunePercent } : { label: "倒大霉", percent: misfortunePercent };
}

/** "我也试试"（原地重开一次内联搜索）+ 可选"同款问题"（原样复用同一段文本，
 * 方便别人测一模一样的所求事项）+ "转发"（挑一个聊天分享同一次内联搜索）。 */
function buildRetryKeyboard(text: string | undefined): InlineKeyboard {
  const keyboard: InlineKeyboard = new InlineKeyboard().switchInlineCurrent("我也试试", "");
  if (text) {
    const sameQuestionLabel: string = text.length > SAME_QUESTION_LABEL_MAX_LEN ? `${text.slice(0, SAME_QUESTION_LABEL_MAX_LEN)}…` : text;
    keyboard.switchInlineCurrent(sameQuestionLabel, text);
  }
  keyboard.row().switchInline("转发", text ?? "");
  return keyboard;
}

function buildFortuneResult(draw: LuckDraw, userId: number, userLabel: string, text: string | undefined): InlineQueryResultArticle {
  const bodyText: string = text
    ? `你好，${userLabel}\n所求事项: ${text}\n结果: ${draw.tier.label}\n${draw.tier.comment}`
    : `你好，${userLabel}\n汝的今日运势: ${draw.tier.label}\n${draw.tier.comment}`;
  registerPendingRendering(luckCacheKey(userId, text), bodyText);
  return InlineQueryResultBuilder.article(text ? "luck-fortune-text" : "luck-fortune", "未卜先知", {
    description: text ? `所求事项：${text}` : "测测你今天的运势",
    reply_markup: buildRetryKeyboard(text),
    thumbnail_url: FORTUNE_THUMBNAIL_URL,
  }).text(bodyText);
}

/** 概率数字固定展示两位小数（toFixed(2)），即便滚动结果恰好落在整数或一位小数上也补齐，
 * 避免同一档不同次抽签的展示位数忽多忽少。 */
function buildProbabilityResult(draw: LuckDraw, userId: number, userLabel: string): InlineQueryResultArticle {
  const { label, percent } = pickDominantProbability(draw);
  const bodyText: string = `你好，${userLabel}\n汝今天${label}概率是 ${percent.toFixed(2)}%`;
  registerPendingRendering(luckCacheKey(userId, undefined), bodyText);
  return InlineQueryResultBuilder.article("luck-probability", "概率论！", {
    description: "看看你今天行大运/倒大霉的概率",
    reply_markup: buildRetryKeyboard(undefined),
    thumbnail_url: PROBABILITY_THUMBNAIL_URL,
  }).text(bodyText);
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
    description: `本天才每分钟最多接 ${RATE_LIMIT_MAX_CALLS_PER_MINUTE} 次，杂鱼先歇会儿再来吧`,
  }).text(`笨蛋，问太快啦，本天才每分钟最多接 ${RATE_LIMIT_MAX_CALLS_PER_MINUTE} 次，杂鱼先歇会儿再来吧♡`);
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
  const draw: LuckDraw = getOrDrawLuck(fromUser.id, text || undefined);
  const results: InlineQueryResultArticle[] = text
    ? [buildFortuneResult(draw, fromUser.id, userLabel, text)]
    : [buildFortuneResult(draw, fromUser.id, userLabel, undefined), buildProbabilityResult(draw, fromUser.id, userLabel)];

  await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
}
