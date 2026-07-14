/** 抽签命令（src/commands/luckChallenge.ts）的吉凶档定义。 */
export interface LuckTier {
  label: string;
  /** 占 1~100 的份额（百分比），全表之和必须是 100，用于抽签本身。 */
  weight: number;
  comment: string;
  /** 落在这一档时，行大运（大吉）概率；倒大霉（大凶）概率 = 100 - fortunePercent。
   * 按吉凶结果查表得出，不再随机，同一档每次查到的都一样，天然满足「固定」。 */
  fortunePercent: number;
}
