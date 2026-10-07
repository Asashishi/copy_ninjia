import type { AtmosphereTexts } from "./atmosphere";

/** 抽签命令（packages/commands/luckChallenge/）的吉凶档定义。 */
export interface LuckTier {
  readonly label: keyof AtmosphereTexts["LUCK_TIER_COMMENTS"];
  /** 抽签份额（百分比），全表之和必须是 100，用于抽签本身。 */
  readonly weight: number;
  /** 落在这一档时，行大运（大吉）概率的浮动区间 [min, max]（百分比，闭区间，
   * 取值四舍五入到两位小数）；倒大霉（大凶）概率 = 100 - 行大运概率。具体值由
   * commands/luckChallenge/draw.ts 的 deriveLuckDraw 按当日密钥与 cacheKey 派生的
   * 摘要在区间内取得，同一档的不同抽签可得到不同数字；抽签结果随 LuckDraw 进日缓存与落盘。 */
  readonly fortunePercentRange: readonly [number, number];
}

/** 一次完整的抽签结果：抽中的吉凶档 + 该档区间内取得的行大运具体数值。是
 * dailyLuckCache（packages/cache/main/luckChallenge.ts）的元素类型，对应落盘形状
 * types/diskIO/storage.ts 的 LuckDrawRecord。 */
export interface LuckDraw {
  tier: LuckTier;
  /** tier.fortunePercentRange 内取得的具体值（%，两位小数），语义见该字段注释。 */
  fortunePercent: number;
}

/** 带隐藏验签回执的一条内联抽签正文。 */
export interface SignedLuckResult {
  text: string;
  receiptOffset: number;
  receiptLength: number;
  receiptUrl: string;
}
