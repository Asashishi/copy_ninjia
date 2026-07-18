import { LUCK_TIERS } from "../../consts/luckChallenge";
import { deriveLuckEntropy } from "../../libs/luckReceipt";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw, LuckTier } from "../../types/luckChallenge";

function drawLuckTier(roll: number): LuckTier {
  let cumulative: number = 0;
  for (const tier of LUCK_TIERS) {
    cumulative += tier.weight;
    if (roll < cumulative) return tier;
  }
  return LUCK_TIERS[LUCK_TIERS.length - 1]!;
}

function rollFortunePercent([min, max]: [number, number], fraction: number): number {
  const raw: number = min + fraction * (max - min);
  return Math.round(raw * 100) / 100;
}

/** 当日密钥 + cache key 的确定性抽签；pending 淘汰或进程重启后仍得到同一结果。 */
export function deriveLuckDraw(secret: LuckReceiptSecret, cacheKey: string): LuckDraw {
  const entropy: Buffer = deriveLuckEntropy(secret, cacheKey);
  const tierRoll: number = entropy.readUInt32BE(0) / 0x1_0000_0000 * 100;
  const tier: LuckTier = drawLuckTier(tierRoll);
  const fraction: number = entropy.readUInt32BE(4) / 0x1_0000_0000;
  return { tier, fortunePercent: rollFortunePercent(tier.fortunePercentRange, fraction) };
}
