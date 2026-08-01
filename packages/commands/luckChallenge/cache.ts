import {
  dailyLuckCache,
  dailyLuckCacheSaturated,
  luckCacheState,
  luckReceiptSecretState,
  luckRuntimeState,
  pendingLuckDraws,
} from "../../cache/main/luckChallenge";
import { DAILY_LUCK_CACHE_MAX, LUCK_TIERS, PENDING_LUCK_CACHE_MAX } from "../../consts/luckChallenge";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { logger } from "../../infra/logger";
import { getTokyoDateKey } from "../../libs/time";
import type { DiskIORecoveryTransport } from "../../types/diskIO";
import type { LuckDayCache, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw, LuckTier } from "../../types/luckChallenge";
import { deriveLuckDraw } from "./draw";
import { ensureLuckReceiptSecret, onDiskIORespawn, postDiskIO } from "../../infra/diskIO";
import { setBoundedMapValue } from "../../libs/boundedMap";

/** 进程内是否发生过跨东京零点的日切换（即 adoptLuckSecret 清空过前一天的
 *  pending）。见 promotePendingDraw：切换后 pending 未命中不再允许重建派生。 */

function adoptLuckSecret(secret: LuckReceiptSecret): void {
  if (luckCacheState.dayKey && luckCacheState.dayKey !== secret.day) {
    luckRuntimeState.daySwitchedInProcess = true;
  }
  luckReceiptSecretState.current = secret;
  luckCacheState.dayKey = secret.day;
  dailyLuckCache.clear();
  dailyLuckCacheSaturated.current = false;
  pendingLuckDraws.clear();
}

/**
 * 收下一条当日已确认结果，撑满时拒收并只记一行日志。
 *
 * 拒收而不是淘汰最旧：淘汰等于让一个刷子把当天正常用户的记录顶掉。被拒的 key
 * 只是「今天测过」记不住——派生是确定性的，重新预览仍是同一条结果（取舍见
 * consts/luckChallenge.ts 的 DAILY_LUCK_CACHE_MAX）。
 * @returns 真的收下了为 true；撑满拒收为 false，调用方据此决定要不要落盘。
 */
function admitDailyLuckEntry(cacheKey: string, draw: LuckDraw): boolean {
  if (!dailyLuckCache.has(cacheKey) && dailyLuckCache.size >= DAILY_LUCK_CACHE_MAX) {
    if (!dailyLuckCacheSaturated.current) {
      dailyLuckCacheSaturated.current = true;
      logger.error(
        `Daily luck cache reached its ${DAILY_LUCK_CACHE_MAX}-entry ceiling for ${luckCacheState.dayKey}; ` +
        "further confirmed draws will not be remembered or persisted until the Tokyo day rolls over."
      );
    }
    return false;
  }
  dailyLuckCache.set(cacheKey, draw);
  return true;
}

type LuckSecretLoader = (day: string) => Promise<LuckReceiptSecret>;

interface EnsureLuckCacheFreshOptions {
  loadSecret: LuckSecretLoader;
  retryAfterSharedFailure: boolean;
}

async function rotateLuckCache(
  requestedDay: string,
  loadSecret: LuckSecretLoader
): Promise<void> {
  let targetDay: string = requestedDay;
  for (;;) {
    const secret: LuckReceiptSecret = await loadSecret(targetDay);
    if (secret.day !== targetDay) {
      throw new Error(`Disk I/O Worker returned luck secret for ${secret.day}, expected ${targetDay}`);
    }
    const currentDay: string = getTokyoDateKey();
    if (currentDay === targetDay) {
      adoptLuckSecret(secret);
      return;
    }
    targetDay = currentDay;
  }
}

async function ensureLuckCacheFresh({
  loadSecret,
  retryAfterSharedFailure,
}: EnsureLuckCacheFreshOptions): Promise<void> {
  for (;;) {
    const todayKey: string = getTokyoDateKey();
    if (
      todayKey === luckCacheState.dayKey &&
      luckReceiptSecretState.current?.day === todayKey
    ) {
      return;
    }
    const sharedRefresh: Promise<void> | null = luckRuntimeState.dayRefreshPromise;
    if (sharedRefresh !== null) {
      try {
        await sharedRefresh;
      } catch (error: unknown) {
        if (!retryAfterSharedFailure) throw error;
      } finally {
        if (luckRuntimeState.dayRefreshPromise === sharedRefresh) {
          luckRuntimeState.dayRefreshPromise = null;
        }
      }
      continue;
    }
    const refresh: Promise<void> = rotateLuckCache(todayKey, loadSecret);
    luckRuntimeState.dayRefreshPromise = refresh;
    try {
      await refresh;
      return;
    } finally {
      if (luckRuntimeState.dayRefreshPromise === refresh) {
        luckRuntimeState.dayRefreshPromise = null;
      }
    }
  }
}

/** 跨东京零点时向唯一磁盘线程取得新日密钥，并整体切换日缓存。 */
export function ensureLuckCacheFreshForToday(): Promise<void> {
  return ensureLuckCacheFresh({
    loadSecret: ensureLuckReceiptSecret,
    retryAfterSharedFailure: false,
  });
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
  setBoundedMapValue({
    map: pendingLuckDraws,
    key: cacheKey,
    value: draw,
    maxEntries: PENDING_LUCK_CACHE_MAX,
  });
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

  // 撑满时连落盘消息都不投：那正是 Worker 侧当日镜像与 memory/luck/<day>.json
  // 一起无界增长的入口。
  if (!admitDailyLuckEntry(cacheKey, draw)) return;
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
  onDiskIORespawn("daily luck", DISK_IO_RESPAWN_PRIORITIES.DAILY_LUCK, async (
    transport: DiskIORecoveryTransport
  ): Promise<boolean> => {
    await ensureLuckCacheFresh({
      loadSecret: transport.ensureLuckReceiptSecret,
      retryAfterSharedFailure: true,
    });
    for (const [key, draw] of dailyLuckCache) {
      if (!transport.post({
        type: "luckDraw",
        day: luckCacheState.dayKey,
        key,
        label: draw.tier.label,
        fortunePercent: draw.fortunePercent,
      })) {
        return false;
      }
    }
    return true;
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
    // 恢复同样过闸：磁盘上那份可能是上一版本留下的、超过当前上限的文件。
    if (!admitDailyLuckEntry(key, { tier, fortunePercent: record.fortunePercent })) break;
  }
}
