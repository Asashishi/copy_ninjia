import {
  dailyLuckCache,
  luckCacheState,
  luckReceiptSecretState,
  pendingLuckDraws,
} from "../../cache/luckChallenge";
import { LUCK_TIERS, PENDING_LUCK_CACHE_MAX } from "../../consts/luckChallenge";
import { ensureLuckReceiptSecret, onDiskIORespawn, postDiskIO } from "../../infra/diskIO";
import { logger } from "../../infra/logger";
import { getTokyoDateKey } from "../../libs/time";
import type { LuckDayCache, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw, LuckTier } from "../../types/luckChallenge";
import { deriveLuckDraw } from "./draw";

let luckDayRefreshPromise: Promise<void> | null = null;
let respawnRecoveryInitialized: boolean = false;

function adoptLuckSecret(secret: LuckReceiptSecret): void {
  luckReceiptSecretState.current = secret;
  luckCacheState.dayKey = secret.day;
  dailyLuckCache.clear();
  pendingLuckDraws.clear();
}

/** 跨东京零点时向唯一磁盘线程取得新日密钥，并整体切换日缓存。 */
export async function ensureLuckCacheFreshForToday(): Promise<void> {
  const todayKey: string = getTokyoDateKey();
  if (todayKey === luckCacheState.dayKey && luckReceiptSecretState.current?.day === todayKey) return;
  if (luckDayRefreshPromise !== null) return luckDayRefreshPromise;

  luckDayRefreshPromise = (async (): Promise<void> => {
    let requestedDay: string = todayKey;
    for (;;) {
      const secret: LuckReceiptSecret = await ensureLuckReceiptSecret(requestedDay);
      if (secret.day !== requestedDay) {
        throw new Error(`Disk I/O Worker returned luck secret for ${secret.day}, expected ${requestedDay}`);
      }
      const currentDay: string = getTokyoDateKey();
      if (currentDay === requestedDay) {
        adoptLuckSecret(secret);
        return;
      }
      requestedDay = currentDay;
    }
  })();
  try {
    await luckDayRefreshPromise;
  } finally {
    luckDayRefreshPromise = null;
  }
}

function currentLuckSecret(): LuckReceiptSecret {
  const secret: LuckReceiptSecret | null = luckReceiptSecretState.current;
  if (secret?.day !== luckCacheState.dayKey) {
    throw new Error("Daily luck receipt secret is not initialized");
  }
  return secret;
}

/** 预览优先复用已确认和 pending 结果；新结果只进有界 pending 缓存。 */
export function getOrDrawLuck(cacheKey: string): LuckDraw {
  const confirmed: LuckDraw | undefined = dailyLuckCache.get(cacheKey);
  if (confirmed) return confirmed;
  const pending: LuckDraw | undefined = pendingLuckDraws.get(cacheKey);
  if (pending) return pending;

  const draw: LuckDraw = deriveLuckDraw(currentLuckSecret(), cacheKey);
  if (pendingLuckDraws.size >= PENDING_LUCK_CACHE_MAX) {
    const evictedKey: string | undefined = pendingLuckDraws.keys().next().value;
    if (evictedKey !== undefined) pendingLuckDraws.delete(evictedKey);
  }
  pendingLuckDraws.set(cacheKey, draw);
  return draw;
}

/** chosen result 或有效签名把 pending 转正；重复确认幂等。 */
export function promotePendingDraw(cacheKey: string): void {
  const draw: LuckDraw = pendingLuckDraws.get(cacheKey) ?? deriveLuckDraw(currentLuckSecret(), cacheKey);
  pendingLuckDraws.delete(cacheKey);
  if (dailyLuckCache.has(cacheKey)) return;

  dailyLuckCache.set(cacheKey, draw);
  postDiskIO({
    type: "luckDraw",
    day: luckCacheState.dayKey,
    key: cacheKey,
    label: draw.tier.label,
    fortunePercent: draw.fortunePercent,
  });
}

function initializeRespawnRecovery(): void {
  if (respawnRecoveryInitialized) return;
  respawnRecoveryInitialized = true;
  onDiskIORespawn(() => {
    void ensureLuckCacheFreshForToday()
      .then(() => {
        for (const [key, draw] of dailyLuckCache) {
          postDiskIO({
            type: "luckDraw",
            day: luckCacheState.dayKey,
            key,
            label: draw.tier.label,
            fortunePercent: draw.fortunePercent,
          });
        }
      })
      .catch((error: unknown) => {
        logger.error("Failed to restore daily luck secret after Disk I/O Worker respawn:", error);
      });
  });
}

/** 启动时接管当天密钥与已确认缓存，并显式安装 diskIO Worker 重建重放。 */
export function restoreLuckState(secret: LuckReceiptSecret, loaded: LuckDayCache | null): void {
  initializeRespawnRecovery();
  const todayKey: string = getTokyoDateKey();
  if (secret.day !== todayKey) {
    throw new Error(`Loaded luck receipt secret is for ${secret.day}, expected ${todayKey}`);
  }
  adoptLuckSecret(secret);
  if (loaded?.day !== todayKey) return;

  for (const [key, record] of loaded.entries) {
    const tier: LuckTier | undefined = LUCK_TIERS.find((candidate) => candidate.label === record.label);
    if (!tier) {
      logger.error(
        `Restored luck entry "${key}" has label "${record.label}" that no longer matches any LUCK_TIERS entry; ` +
        "dropping it, the user will redraw today."
      );
      continue;
    }
    const [min, max] = tier.fortunePercentRange;
    if (record.fortunePercent < min || record.fortunePercent > max) {
      logger.error(
        `Restored luck entry "${key}" has fortunePercent ${record.fortunePercent} outside tier ` +
        `"${record.label}"'s current range [${min}, ${max}]; dropping it, the user will redraw today.`
      );
      continue;
    }
    dailyLuckCache.set(key, { tier, fortunePercent: record.fortunePercent });
  }
}
