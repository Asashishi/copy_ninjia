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

function rollFortunePercent([min, max]: readonly [number, number], fraction: number): number {
  const raw: number = min + fraction * (max - min);
  return Math.round(raw * 100) / 100;
}

/** 从固定 32 字节摘要读取无符号大端整数，不建立 DataView 或 Buffer 视图。 */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1_000000 +
    bytes[offset + 1]! * 0x1_0000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!;
}

/** 当日密钥 + cache key 的确定性抽签；pending 淘汰或进程重启后仍得到同一结果。 */
export function deriveLuckDraw(secret: LuckReceiptSecret, cacheKey: string): LuckDraw {
  const entropy: Uint8Array = deriveLuckEntropy(secret, cacheKey);
  const tierRoll: number = readUint32BE(entropy, 0) / 0x1_0000_0000 * 100;
  const tier: LuckTier = drawLuckTier(tierRoll);
  const fraction: number = readUint32BE(entropy, 4) / 0x1_0000_0000;
  return { tier, fortunePercent: rollFortunePercent(tier.fortunePercentRange, fraction) };
}
