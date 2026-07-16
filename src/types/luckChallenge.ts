/** 抽签命令（src/commands/luckChallenge.ts）的吉凶档定义。 */
export interface LuckTier {
  label: string;
  /** 占 1~100 的份额（百分比），全表之和必须是 100，用于抽签本身。 */
  weight: number;
  comment: string;
  /** 落在这一档时，行大运（大吉）概率的浮动区间 [min, max]（百分比，闭区间，
   * 支持两位小数）；倒大霉（大凶）概率 = 100 - 行大运概率。每次抽到新结果时都在
   * 区间内重新滚动一次（见 commands/luckChallenge.ts 的 rollFortunePercent），不再是
   * 按档查表就唯一确定的定值——同一档每次抽到的具体数字可能不同，但同一次抽签
   * 结果（连同 label）会随 LuckDraw 一起进日缓存/落盘，当天不会变。 */
  fortunePercentRange: [number, number];
}

/** 一次完整的抽签结果：抽中的吉凶档 + 该档区间内浮动出的行大运具体数值。是
 * dailyLuckCache（src/cache/luckChallenge.ts）的元素类型，也是落盘往返（见
 * types/diskIO.ts 的 LuckDrawRecord）在主线程内存里的对应形状。 */
export interface LuckDraw {
  tier: LuckTier;
  /** tier.fortunePercentRange 内滚动出的具体值（%，两位小数），语义见该字段注释。 */
  fortunePercent: number;
}
