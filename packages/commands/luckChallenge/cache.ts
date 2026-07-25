import {
  dailyLuckCache,
  luckCacheState,
  luckReceiptSecretState,
  luckRuntimeState,
  pendingLuckDraws,
} from "../../cache/luckChallenge";
import { LUCK_TIERS, PENDING_LUCK_CACHE_MAX } from "../../consts/luckChallenge";
import { logger } from "../../infra/logger";
import { getTokyoDateKey } from "../../libs/time";
import type { LuckDayCache, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw, LuckTier } from "../../types/luckChallenge";
import { deriveLuckDraw } from "./draw";
import { ensureLuckReceiptSecret, onDiskIORespawn, postDiskIO } from "./persistence";

/** 进程内是否发生过跨东京零点的日切换（即 adoptLuckSecret 清空过前一天的
 *  pending）。见 promotePendingDraw：切换后 pending 未命中不再允许重建派生。 */

function adoptLuckSecret(secret: LuckReceiptSecret): void {
  if (luckCacheState.dayKey && luckCacheState.dayKey !== secret.day) {
    luckRuntimeState.daySwitchedInProcess = true;
  }
  luckReceiptSecretState.current = secret;
  luckCacheState.dayKey = secret.day;
  dailyLuckCache.clear();
  pendingLuckDraws.clear();
}

/** 跨东京零点时向唯一磁盘线程取得新日密钥，并整体切换日缓存。 */
export async function ensureLuckCacheFreshForToday(): Promise<void> {
  const todayKey: string = getTokyoDateKey();
  if (todayKey === luckCacheState.dayKey && luckReceiptSecretState.current?.day === todayKey) return;
  if (luckRuntimeState.dayRefreshPromise !== null) return luckRuntimeState.dayRefreshPromise;

  luckRuntimeState.dayRefreshPromise = (async (): Promise<void> => {
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
    await luckRuntimeState.dayRefreshPromise;
  } finally {
    luckRuntimeState.dayRefreshPromise = null;
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

/**
 * chosen result 或有效签名把 pending 转正；重复确认幂等。
 *
 * pending 未命中时的重建派生（deriveLuckDraw 是确定性的）只对「同一天丢了
 * 内存」的场景成立：进程重启后确认信号迟到（pending 全丢、密钥同日），
 * 重建结果与用户看到的完全一致。而进程内一旦跨过东京零点，未命中的主因
 * 就是旧日 pending 被 adoptLuckSecret 整体清空——用新一天的密钥重派生出来
 * 的是用户根本没见过的另一个结果，不能落盘「确认」，除非调用方能证明确认
 * 属于当天（签名回执自带发放当天的密钥、验签即证明，见 receipt.ts 的
 * confirmLuckDraw）；chosen_inline_result 不带任何日期证明，跨天后一律
 * fail closed 丢弃，与回执路径「验签失败即丢弃」对齐。同日内被容量淘汰的
 * pending 被顺带拒绝也无损：派生是确定性的，重新预览仍是同一结果。
 * @param confirmedForToday 调用方已证明这次确认属于当天（目前只有签名回执
 *   验签通过这一种证明），允许在跨天后仍走重建派生。
 */
export function promotePendingDraw(cacheKey: string, confirmedForToday: boolean = false): void {
  const pending: LuckDraw | undefined = pendingLuckDraws.get(cacheKey);
  pendingLuckDraws.delete(cacheKey);
  if (dailyLuckCache.has(cacheKey)) return;
  if (!pending && luckRuntimeState.daySwitchedInProcess && !confirmedForToday) return;
  const draw: LuckDraw = pending ?? deriveLuckDraw(currentLuckSecret(), cacheKey);

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
  if (luckRuntimeState.respawnRecoveryInitialized) return;
  luckRuntimeState.respawnRecoveryInitialized = true;
  onDiskIORespawn((): void => {
    void ensureLuckCacheFreshForToday()
      .then((): void => {
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
      .catch((error: unknown): void => {
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
    const tier: LuckTier | undefined = LUCK_TIERS.find((candidate: LuckTier): boolean => candidate.label === record.label);
    if (!tier) {
      logger.error(
        `Restored luck entry "${key}" has label "${record.label}" that no longer matches any LUCK_TIERS entry; ` +
        "dropping it, the user will redraw today."
      );
      continue;
    }
    const [min, max]: readonly [number, number] = tier.fortunePercentRange;
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
